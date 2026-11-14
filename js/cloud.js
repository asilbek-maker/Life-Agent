// Life Agent cloud sync (Supabase).
// Offline-first: the app always saves to its local cache first. This module keeps a
// queue ("outbox") of changes and sends them when the phone is online and signed in.
(function () {
  "use strict";

  const CFG = window.LIFE_AGENT_CONFIG || {};
  const KINDS = ["entries", "goals", "reminders", "links", "plans"];
  const OUTBOX_KEY = "lifeagent.outbox", META_KEY = "lifeagent.cloud";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const BATCH = 200;

  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } };
  const iso = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();

  // When a reminder is next due, in this phone's local time (the server cron reads it).
  function nextDue(r, from = new Date()) {
    const [h, m] = String(r.time || "09:00").split(":").map(Number);
    const at = (dateStr) => { const [y, mo, d] = dateStr.split("-").map(Number); return new Date(y, mo - 1, d, h, m, 0); };
    if (r.repeat === "once") { const d = at(r.date || ymd(from)); return d > from ? d.toISOString() : null; }
    const startDay = r.date || "0000-00-00";
    const weekday = r.repeat === "weekly" && r.date ? at(r.date).getDay() : null;
    for (let i = 0; i < 400; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0);
      if (d <= from || ymd(d) < startDay) continue;
      const wd = d.getDay();
      if (r.repeat === "weekdays" && (wd === 0 || wd === 6)) continue;
      if (r.repeat === "weekly" && wd !== weekday) continue;
      return d.toISOString();
    }
    return null;
  }

  // App item <-> database row
  const MAP = {
    entries: {
      to: (e) => ({ id: e.id, area: e.area, date: e.date, title: e.title || "Entry", minutes: e.minutes ?? null, details: e.details || "", data: e.data || {}, source: e.source || "app", created_at: iso(e.createdAt) }),
      from: (r) => ({ id: r.id, area: r.area, date: r.date, title: r.title, minutes: r.minutes, details: r.details || "", data: r.data || {}, source: r.source, createdAt: Date.parse(r.created_at) }),
    },
    goals: {
      to: (g) => ({ id: g.id, area: g.area || "other", text: g.text || "Goal", deadline: g.deadline || null, done: !!g.done, completed_on: g.completed || null,
        target_value: g.target ?? null, current_value: g.current ?? null, unit: g.unit ?? null, created_at: g.created ? g.created + "T12:00:00Z" : iso() }),
      from: (r) => ({ id: r.id, area: r.area, text: r.text, deadline: r.deadline, done: r.done, completed: r.completed_on, target: r.target_value, current: r.current_value, unit: r.unit, created: String(r.created_at).slice(0, 10) }),
    },
    reminders: {
      to: (r) => ({ id: r.id, text: r.text || "Reminder", area: r.area || "other", time_of_day: r.time || "09:00", repeat: r.repeat || "daily", start_date: r.date || ymd(new Date()),
        timezone: timezone(), next_due_at: r.active === false ? null : nextDue(r), active: r.active !== false }),
      from: (r) => ({ id: r.id, text: r.text, area: r.area, time: String(r.time_of_day).slice(0, 5), repeat: r.repeat, date: r.start_date, active: r.active, created: String(r.created_at).slice(0, 10) }),
    },
    plans: {
      to: (p) => ({ id: p.id, name: p.name || "My plan", settings: p.settings || {}, days: p.days || [], next_day: p.nextDay || 0, active: p.active !== false }),
      from: (r) => ({ id: r.id, name: r.name, settings: r.settings || {}, days: r.days || [], nextDay: r.next_day || 0, active: r.active, created: String(r.created_at).slice(0, 10) }),
    },
    links: {
      to: (l) => ({ id: l.id, area: l.area, name: l.name, url: l.url }),
      from: (r) => ({ id: r.id, area: r.area, name: r.name, url: r.url }),
    },
  };

  const configured = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase && window.supabase.createClient);
  let client = null, user = null, hooks = null;
  let outbox = load(OUTBOX_KEY, []), meta = load(META_KEY, {});
  let flushing = false, pulling = false, pullAgain = false, lastError = null, started = false;

  if (configured) {
    client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "lifeagent.auth" },
    });
  }

  const online = () => navigator.onLine !== false;
  const status = () => ({ configured, signedIn: !!user, email: user ? user.email : null, pending: outbox.length, syncing: flushing || pulling, online: online(), lastSync: meta.lastSync || null, error: lastError });
  const emit = () => { if (hooks && hooks.onStatus) { try { hooks.onStatus(status()); } catch (e) {} } };
  const saveOutbox = () => save(OUTBOX_KEY, outbox);
  const isNetworkError = (e) => !e || (!e.code && !e.status) || /fetch|network|load failed/i.test(String(e.message || ""));

  function enqueue(kind, op, item) {
    if (!MAP[kind] || !item || !UUID.test(String(item.id))) return;
    // Keep only the newest change per row. The older op object is dropped rather than edited,
    // so a request already on its way is never changed underneath.
    outbox = outbox.filter((o) => !(o.kind === kind && o.id === item.id));
    outbox.push(op === "put" ? { kind, op, id: item.id, item } : { kind, op: "del", id: item.id });
  }

  async function flush() {
    if (flushing || !client || !user || !online()) return;
    flushing = true; emit();
    try {
      while (outbox.length) {
        const first = outbox[0];
        // Send a run of saves for the same table in one request.
        const batch = [];
        if (first.op === "put") { for (const o of outbox) { if (o.kind === first.kind && o.op === "put" && batch.length < BATCH) batch.push(o); else break; } }
        else batch.push(first);
        let error = null;
        try {
          if (first.op === "put") ({ error } = await client.from(first.kind).upsert(batch.map((o) => MAP[o.kind].to(o.item))));
          else ({ error } = await client.from(first.kind).update({ deleted_at: new Date().toISOString() }).eq("id", first.id));
        } catch (e) { error = e; }
        if (error && (isNetworkError(error) || /jwt|401/i.test(String(error.message || error.code || "")))) break;  // try again later
        if (error && batch.length > 1) {
          // The server refused the batch: send its rows one by one so one bad row can't block the rest.
          let stop = false;
          for (const o of batch) {
            let e1 = null;
            try { ({ error: e1 } = await client.from(o.kind).upsert(MAP[o.kind].to(o.item))); } catch (e) { e1 = e; }
            if (e1 && isNetworkError(e1)) { stop = true; break; }
            if (e1) lastError = e1.message || "sync error";
            outbox = outbox.filter((x) => x !== o);
          }
          saveOutbox(); emit();
          if (stop) break;
          continue;
        }
        if (error) lastError = error.message || "sync error";   // a single refused change is dropped
        outbox = outbox.filter((o) => !batch.includes(o));
        saveOutbox(); emit();
      }
    } finally { flushing = false; emit(); }
  }

  async function pull() {
    if (!client || !user || !online()) return;
    if (pulling) { pullAgain = true; return; }
    pulling = true; emit();
    try {
      do {
        pullAgain = false;
        for (const kind of KINDS) {
          let rows = [];
          for (let from = 0; ; from += 1000) {
            const { data, error } = await client.from(kind).select("*").is("deleted_at", null).order("id").range(from, from + 999);
            if (error) throw error;
            rows = rows.concat(data);
            if (data.length < 1000) break;
          }
          const list = rows.map(MAP[kind].from);
          // Changes still waiting in the outbox win over what the server has.
          for (const o of outbox) {
            if (o.kind !== kind) continue;
            const i = list.findIndex((x) => x.id === o.id);
            if (o.op === "put") { if (i >= 0) list[i] = o.item; else list.push(o.item); } else if (i >= 0) list.splice(i, 1);
          }
          hooks.setKind(kind, list);
        }
      } while (pullAgain);
      meta.lastSync = Date.now(); save(META_KEY, meta); lastError = null;
    } catch (e) {
      if (!isNetworkError(e)) lastError = e.message || "sync error";
    } finally { pulling = false; emit(); }
  }

  async function sync() { await flush(); await pull(); }

  async function onSignedIn() {
    const st = hooks.getState();
    if (meta.userId && meta.userId !== user.id) {
      // A different account on this phone: don't mix the two. Show that account's data.
      outbox = []; saveOutbox(); meta = { userId: user.id }; save(META_KEY, meta);
    } else if (!meta.userId) {
      // First sign-in on this phone: upload everything already saved here (one-time import).
      let n = 0;
      for (const kind of KINDS) for (const item of st[kind] || []) {
        if (!UUID.test(String(item.id))) continue;
        enqueue(kind, "put", kind === "entries" && !item.source ? { ...item, source: "import" } : item); n++;
      }
      meta.userId = user.id; meta.imported = n; meta.importedAt = Date.now(); save(META_KEY, meta); saveOutbox();
      if (n && hooks.onNotice) hooks.onNotice(`Uploading ${n} saved item${n === 1 ? "" : "s"} to your account…`);
    }
    try { await client.from("profile").upsert({ user_id: user.id, timezone: timezone() }); } catch (e) {}
    await sync();
  }

  window.LifeCloud = {
    configured,
    status,
    get client() { return client; },
    start(h) {
      hooks = h;
      if (!client || started) { emit(); return; }
      started = true;
      client.auth.onAuthStateChange((evt, session) => {
        const u = (session && session.user) || null, was = user && user.id;
        user = u; emit();
        if (hooks.onAuth) { try { hooks.onAuth(evt, u); } catch (e) {} }
        // Never call Supabase from inside this callback: do the work on the next tick.
        if (u && u.id !== was) setTimeout(() => { onSignedIn(); }, 0);
      });
      window.addEventListener("online", () => { emit(); sync(); });
      window.addEventListener("offline", emit);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
      setInterval(() => { if (outbox.length) flush(); }, 30000);
      emit();
    },
    queue(kind, op, item) {
      enqueue(kind, op, item); saveOutbox();
      if (pulling) pullAgain = true;
      emit();
      if (user) flush();
    },
    async sendCode(email) {
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
    },
    async verifyCode(email, token) {
      const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw error;
    },
    async signOut() { await client.auth.signOut(); },
    sync,
    nextDue,
  };
})();
