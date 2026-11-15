// Life Agent quick-log parser (no AI needed).
// Turns plain text like "bench 60kg 4x8, studied math 90 min" into the same tool calls
// the Claude agent would make, so the app works without an API key and offline.
(function () {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return ymd(new Date(y, m - 1, d + n, 12)); };
  const cap = (s) => { s = String(s || "").trim().replace(/\s+/g, " "); return s ? s[0].toUpperCase() + s.slice(1) : s; };
  const round = (n, step) => Math.round(n / step) * step;

  const EXERCISES = {
    "bench": "Bench press", "bench press": "Bench press", "incline": "Incline bench press", "incline bench": "Incline bench press",
    "squat": "Squat", "squats": "Squat", "deadlift": "Deadlift", "deadlifts": "Deadlift", "dl": "Deadlift", "rdl": "Romanian deadlift",
    "ohp": "Overhead press", "overhead press": "Overhead press", "shoulder press": "Shoulder press", "row": "Barbell row", "rows": "Barbell row",
    "curl": "Biceps curl", "curls": "Biceps curl", "bicep curl": "Biceps curl", "pullups": "Pull-up", "pull ups": "Pull-up", "pull-ups": "Pull-up", "pullup": "Pull-up",
    "pushups": "Push-up", "push ups": "Push-up", "push-ups": "Push-up", "pushup": "Push-up", "dips": "Dips", "lunges": "Lunge", "lunge": "Lunge",
    "lat pulldown": "Lat pulldown", "pulldown": "Lat pulldown", "leg press": "Leg press", "plank": "Plank", "lateral raise": "Lateral raise", "lateral raises": "Lateral raise",
  };
  const MOOD_WORDS = { amazing: 5, great: 5, awesome: 5, happy: 5, good: 4, fine: 3, ok: 3, okay: 3, meh: 3, tired: 2, low: 2, sad: 2, stressed: 2, bad: 1, rough: 1, terrible: 1, awful: 1 };
  const UNIT = "(min(?:ute)?s?|mins|m|h|hr|hrs|hours?)";
  const toMinutes = (n, unit) => Math.round(Number(n) * (/^h/i.test(unit) ? 60 : 1));
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  function areaFor(text) {
    const t = text.toLowerCase();
    if (/gym|workout|train|run|lift|exercise|stretch/.test(t)) return "gym";
    if (/study|read|homework|exam|lesson|class|learn|revise/.test(t)) return "study";
    if (/work|meeting|email|report|project/.test(t)) return "work";
    if (/water|sleep|bed|medicine|vitamin|pill|eat|meal/.test(t)) return "health";
    return "other";
  }

  function parseReminder(text, today, now) {
    let rest = text.replace(/^\s*remind(?:\s+me)?(?:\s+to)?\s*/i, "");
    let h = null, mi = 0, m;
    if ((m = rest.match(/\b(?:at\s*)?(\d{1,2})[:.](\d{2})\s*(am|pm)?/i))) { h = +m[1]; mi = +m[2]; if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0); rest = rest.replace(m[0], " "); }
    else if ((m = rest.match(/\b(?:at\s*)?(\d{1,2})\s*(am|pm)\b/i))) { h = (+m[1] % 12) + (/pm/i.test(m[2]) ? 12 : 0); rest = rest.replace(m[0], " "); }
    else if ((m = rest.match(/\bat\s*(\d{1,2})\b/i))) { h = +m[1]; rest = rest.replace(m[0], " "); }
    if (h === null || h > 23 || mi > 59) return null;
    const time = `${pad(h)}:${pad(mi)}`;
    let repeat = "once", date = today;
    if ((m = rest.match(/\b(?:every\s*weekdays?|on\s+weekdays|weekdays)\b/i))) { repeat = "weekdays"; rest = rest.replace(m[0], " "); }
    else if ((m = rest.match(/\b(?:every\s*day|everyday|daily|each\s+day)\b/i))) { repeat = "daily"; rest = rest.replace(m[0], " "); }
    else if ((m = rest.match(new RegExp(`\\b(?:every|on)\\s+(${WEEKDAYS.join("|")})s?\\b`, "i")))) {
      const every = /^every/i.test(m[0]), target = WEEKDAYS.indexOf(m[1].toLowerCase());
      for (let i = 0; i < 7; i++) { const d = addDays(today, i); const [y, mo, dd] = d.split("-").map(Number); if (new Date(y, mo - 1, dd, 12).getDay() === target) { date = d; break; } }
      repeat = every ? "weekly" : "once"; rest = rest.replace(m[0], " ");
    }
    else if ((m = rest.match(/\b(?:every\s*week|weekly)\b/i))) { repeat = "weekly"; rest = rest.replace(m[0], " "); }
    else if ((m = rest.match(/\btomorrow\b/i))) { date = addDays(today, 1); rest = rest.replace(m[0], " "); }
    else {
      rest = rest.replace(/\b(?:today|tonight)\b/i, " ");
      if (time <= `${pad(now.getHours())}:${pad(now.getMinutes())}`) date = addDays(today, 1);   // that time already passed today
    }
    const what = cap(rest.replace(/\b(?:at|on|every|the)\b\s*$/i, "").replace(/^\s*(?:to|about)\s+/i, "").replace(/\s+/g, " ").trim()) || "Reminder";
    return { text: what, time, repeat, date, area: areaFor(what) };
  }

  function parseSegment(seg, date) {
    const s = seg.trim(), low = s.toLowerCase();
    let m;
    if (!s) return null;
    const health = {};
    if ((m = low.match(/\b(?:slept|sleep)\s*(?:for\s*)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)?\b/))) health.sleepHours = +m[1];
    if ((m = low.match(/(\d+)\s*(?:glass(?:es)?|cups?)(?:\s+of)?(?:\s+water)?/)) || (m = low.match(/\bwater\s*:?\s*(\d+)\b/))) health.water = +m[1];
    else if ((m = low.match(/(\d+(?:\.\d+)?)\s*(?:l|liters?|litres?)\s+(?:of\s+)?water/))) health.water = Math.round(+m[1] * 4);
    if (Object.keys(health).length) return { health };

    if ((m = low.match(/\bmood\s*(?:is|was|:)?\s*([1-5])\b/))) return { call: { area: "mood", score: +m[1], date } };
    if ((m = low.match(new RegExp(`\\b(?:feel(?:ing)?|felt|mood(?:\\s+is|\\s+was)?)\\s+(?:really\\s+|very\\s+|pretty\\s+|so\\s+)?(${Object.keys(MOOD_WORDS).join("|")})\\b`)))) return { call: { area: "mood", score: MOOD_WORDS[m[1]], details: cap(s), date } };

    const STUDY = "(?:studied|study|studying|revised|revising|read|reading|learned|learnt|learning|practiced|practised|practicing)";
    if ((m = s.match(new RegExp(`\\b${STUDY}\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b\\s*(?:of\\s+|on\\s+)?(.*)$`, "i")))) return { call: { area: "study", subject: cap(m[3]) || "Study", minutes: toMinutes(m[1], m[2]), date } };
    if ((m = s.match(new RegExp(`\\b${STUDY}\\s+(.+?)\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, "i")))) return { call: { area: "study", subject: cap(m[1]), minutes: toMinutes(m[2], m[3]), date } };

    const WORK = "(?:worked|work|working)";
    if ((m = s.match(new RegExp(`\\b${WORK}\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b\\s*(?:on\\s+)?(.*)$`, "i")))) return { call: { area: "work", title: cap(m[3]) || "Work", minutes: toMinutes(m[1], m[2]), status: "done", date } };
    if ((m = s.match(new RegExp(`\\b${WORK}\\s+(?:on\\s+)?(.+?)\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, "i")))) return { call: { area: "work", title: cap(m[1]), minutes: toMinutes(m[2], m[3]), status: "done", date } };

    // Strength: a weight and/or "sets x reps"
    const wKg = low.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilos?)\b/), wLb = low.match(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/);
    const sr = low.match(/(\d+)\s*(?:x|×|\*)\s*(\d+)/) || low.match(/(\d+)\s*sets?\s*(?:of|x|,)?\s*(\d+)(?:\s*reps?)?/);
    if (wKg || wLb || sr) {
      let name = low;
      for (const hit of [wKg, wLb, sr]) if (hit) name = name.replace(hit[0], " ");
      name = name.split(":").pop().replace(/\b(?:did|done|i|today|at|of|for|with|reps?|sets?)\b|@/g, " ").replace(/\s+/g, " ").trim();
      const call = { area: "gym", exercise: EXERCISES[name] || cap(name) || "Workout", date };
      if (wKg) call.weight = +wKg[1]; else if (wLb) call.weight = round(+wLb[1] * 0.4536, 0.5);
      if (sr) { call.sets = +sr[1]; call.reps = +sr[2]; }
      return { call };
    }

    // Cardio and other timed training
    if ((m = s.match(new RegExp(`\\b(ran|run|running|jogged|jog|walked|walk|cycled|cycling|biked|swam|swimming|yoga|stretched|stretching|gym|workout|trained|training|football|basketball)\\b(.*?)(\\d+(?:\\.\\d+)?)\\s*(km|${UNIT.slice(1, -1)})\\b`, "i")))) {
      const names = { ran: "Run", run: "Run", running: "Run", jogged: "Run", jog: "Run", walked: "Walk", walk: "Walk", cycled: "Cycling", cycling: "Cycling", biked: "Cycling", swam: "Swimming", swimming: "Swimming", stretched: "Stretching", stretching: "Stretching", trained: "Training", training: "Training", gym: "Gym session", workout: "Workout" };
      const call = { area: "gym", exercise: names[m[1].toLowerCase()] || cap(m[1]), date };
      if (/^km$/i.test(m[4])) call.details = `${m[3]} km`; else call.minutes = toMinutes(m[3], m[4]);
      return { call };
    }
    return { unknown: s };
  }

  // parse("bench 60kg 4x8, studied math 90 min") -> { calls: [{name, input}], unknown: [text] }
  function parse(text, opts) {
    const now = (opts && opts.now) || new Date();
    const today = (opts && opts.today) || ymd(now);
    const calls = [], unknown = [];
    for (const line of String(text || "").split(/\n+/)) {
      let t = line.trim();
      if (!t) continue;
      // "…, remind me gym at 18:00": everything from "remind" on is one reminder.
      const at = t.search(/\bremind(?:\s+me)?\b/i);
      if (at >= 0) {
        const part = t.slice(at);
        const r = parseReminder(part, today, now);
        if (r) calls.push({ name: "create_reminder", input: r }); else unknown.push(part + " (add a time, like 18:00)");
        t = t.slice(0, at).replace(/[\s,;+]+(?:and\s*)?$/i, "").trim();
        if (!t) continue;
      }
      let m = t.match(/^(?:set\s+a\s+goal|new\s+goal|my\s+goal\s+is|goal)\s*[:\-]?\s*(?:is\s+)?(?:to\s+)?(.+)$/i);
      if (m) { calls.push({ name: "create_goal", input: { text: cap(m[1]), area: areaFor(m[1]) } }); continue; }

      let date = today, body = t;
      if (/\byesterday\b/i.test(body)) { date = addDays(today, -1); body = body.replace(/\byesterday\b/ig, " "); }
      body = body.replace(/\b(?:today|this morning|tonight)\b/ig, " ");
      const health = {};
      for (const seg of body.split(/\s*(?:,|;|\+|\band\b|\bthen\b)\s*/i)) {
        const r = parseSegment(seg, date);
        if (!r) continue;
        if (r.health) Object.assign(health, r.health);
        else if (r.call) calls.push({ name: "log_entry", input: r.call });
        else if (r.unknown) unknown.push(r.unknown);
      }
      if (Object.keys(health).length) calls.push({ name: "log_entry", input: { area: "health", ...health, date } });
    }
    return { calls, unknown };
  }

  window.LifeQuickLog = { parse };
})();
