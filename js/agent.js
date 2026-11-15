// Life Agent client for the /agent Edge Function (the Claude agent and its tools).
(function () {
  "use strict";

  const CFG = window.LIFE_AGENT_CONFIG || {};
  const endpoint = () => CFG.supabaseUrl + "/functions/v1/agent";
  const timezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } };

  async function token() {
    const c = window.LifeCloud && window.LifeCloud.client;
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  }

  // Errors are plain objects: { code: "signed_out" | "network" | "cancelled" | "not_deployed" | "server" | "stream", message? }
  async function post(body, signal) {
    const t = await token();
    if (!t) throw { code: "signed_out" };
    let res;
    try {
      res = await fetch(endpoint(), { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + t, apikey: CFG.supabaseKey }, body: JSON.stringify({ tz: timezone(), ...body }) });
    } catch (e) { throw { code: e && e.name === "AbortError" ? "cancelled" : "network" }; }
    if (res.status === 404) throw { code: "not_deployed" };
    return res;
  }

  async function call(body, signal) {
    const res = await post(body, signal);
    let j = null;
    try { j = await res.json(); } catch (e) {}
    if (!res.ok || !j) throw { code: "server", status: res.status, message: (j && j.error) || "Server error" };
    return j;
  }

  // Streams the coach's reply. onEvent gets { type: "text", delta } | { type: "tool", name } | { type: "action", action }.
  // Resolves with { ai: false, reason? } when no Claude key is set, else { ai: true, reply, actions }.
  async function chat(input, onEvent, signal) {
    const res = await post({ mode: "chat", text: input.text, history: input.history || [] }, signal);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/event-stream")) {
      let j = null;
      try { j = await res.json(); } catch (e) {}
      if (!res.ok || !j) throw { code: "server", status: res.status, message: (j && j.error) || "Server error" };
      return j;
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", done = null;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let ev = null;
            try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            if (ev.type === "done") done = ev;
            else if (ev.type === "error") throw { code: "stream", message: ev.message || "The coach stopped unexpectedly." };
            else onEvent(ev);
          }
        }
      }
    } catch (e) {
      if (e && e.code) throw e;
      throw { code: e && e.name === "AbortError" ? "cancelled" : "network" };
    }
    if (!done) throw { code: "stream", message: "The reply was cut off. Check your connection." };
    return { ai: true, reply: done.reply, actions: done.actions || [], truncated: !!done.truncated };
  }

  window.LifeAgent = {
    ping: () => call({ mode: "ping" }),
    tools: (calls) => call({ mode: "tools", calls }),
    undo: (ids) => call({ mode: "undo", action_ids: ids }),
    quicklog: (text) => call({ mode: "quicklog", text }),
    chat,
  };
})();
