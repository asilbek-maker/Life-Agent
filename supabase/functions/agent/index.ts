// Life Agent /agent Edge Function.
//
// POST { mode, ... } with the user's Supabase session token.
//   ping      -> { ai }                         is a Claude key configured?
//   tools     -> run tool calls made by the app's own parser (no AI, no cost)
//   undo      -> reverse earlier agent writes
//   quicklog  -> Claude Haiku turns one note into saved records      (needs a key)
//   chat      -> Claude Sonnet coach, streamed as Server-Sent Events (needs a key)
//
// Without the ANTHROPIC_API_KEY secret, quicklog and chat answer { ai: false } and the app
// falls back to its rule-based parser. Setting the secret switches the real agent on.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { COACH_SYSTEM, QUICKLOG_SYSTEM } from "./prompt.ts";
import { type Ctx, addDays, personalRecords, rangeSummary, runTool, safeTz, todayIn, toolDefs, undoActions } from "./tools.ts";

const COACH_MODEL = "claude-sonnet-5-5";
const QUICK_MODEL = "claude-haiku-5-5";
const MAX_ROUNDS = 8;
const CHAT_MAX_TOKENS = 4096;       // cap per model call (thinking + reply)
const QUICK_MAX_TOKENS = 2048;
const MAX_INPUT_CHARS = 4000;       // one message from the user
const QUICK_TOOLS = ["log_entry", "create_goal", "create_reminder"];

// USD per million tokens: [input, output, cache read, cache write]
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

const ALLOWED_ORIGINS = [/^https:\/\/asilbek-maker\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.some((r) => r.test(origin)) ? origin : "https://asilbek-maker.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

type Usage = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number };
function costOf(u: Usage): number {
  const p = PRICES[u.model] || PRICES[COACH_MODEL];
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1_000_000;
}

// A compact picture of the user for the model. It changes often, so it is sent as a
// message (after the cached system prompt and tools), never inside the system prompt.
async function loadContext(sb: SupabaseClient, tz: string, today: string): Promise<string> {
  const from = addDays(today, -13);
  const [summary, recent, goals, reminders, prs] = await Promise.all([
    rangeSummary(sb, from, today),
    sb.from("entries").select("id,area,date,title,minutes,data").is("deleted_at", null).gte("date", from).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(40),
    sb.from("goals").select("id,area,text,deadline,target_value,current_value,unit").is("deleted_at", null).eq("done", false).limit(30),
    sb.from("reminders").select("id,text,time_of_day,repeat,start_date,next_due_at").is("deleted_at", null).eq("active", true).order("next_due_at", { ascending: true }).limit(20),
    personalRecords(sb),
  ]);
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
  const lines = (recent.data || []).map((e: any) => `${e.date} [${e.area}] ${e.title}${e.minutes ? ` ${e.minutes}min` : ""} ${JSON.stringify(e.data)} id=${e.id}`);
  return [
    `Today is ${weekdayName}, ${today} (timezone ${tz}).`,
    `Last 14 days, summarised: ${JSON.stringify(summary)}`,
    `Most recent entries (newest first):\n${lines.join("\n") || "none"}`,
    `Open goals: ${JSON.stringify(goals.data || [])}`,
    `Active reminders: ${JSON.stringify(reminders.data || [])}`,
    `Personal records (heaviest weight per exercise): ${JSON.stringify(Array.isArray(prs) ? prs.slice(0, 20) : prs)}`,
  ].join("\n\n");
}

type LoopOptions = {
  client: Anthropic; model: string; system: string; messages: any[]; tools: any[]; maxTokens: number; effort: "low" | "medium";
  ctx: Ctx; send?: (event: Record<string, unknown>) => void;
};
// The agent loop: call Claude, run the tools it asks for, repeat until it stops (at most MAX_ROUNDS).
async function agentLoop(o: LoopOptions): Promise<{ text: string; usage: Usage[]; refused: boolean; truncated: boolean }> {
  const usage: Usage[] = [];
  let text = "", refused = false, truncated = false, jsonRetries = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const params: any = {
      model: o.model,
      max_tokens: o.maxTokens,
      // Tools render before the system prompt, so this one breakpoint caches both.
      system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
      tools: o.tools,
      output_config: { effort: o.effort },
      messages: o.messages,
    };
    let message: any;
    if (o.send) {
      const stream = o.client.messages.stream(params);
      let roundText = "";
      stream.on("text", (delta: string) => {
        if (!roundText && text) { text += "\n\n"; o.send!({ type: "text", delta: "\n\n" }); }
        roundText += delta; text += delta; o.send!({ type: "text", delta });
      });
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming a tool input can fail to parse; re-issue that turn a couple of times.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }
    } else {
      message = await o.client.messages.create(params);
      const t = message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (t) text += (text ? "\n\n" : "") + t;
    }
    const u = message.usage || {};
    usage.push({ model: message.model || o.model, input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });

    if (message.stop_reason === "refusal") { refused = true; break; }      // never run tools from a refused turn
    if (message.stop_reason === "max_tokens") { truncated = true; break; } // a tool input may be cut off: don't run it
    const toolUses = message.content.filter((b: any) => b.type === "tool_use");
    if (!toolUses.length) break;

    // Pass the assistant turn back unchanged (it carries thinking blocks the next call needs).
    o.messages.push({ role: "assistant", content: message.content });
    const results: any[] = [];
    for (const tu of toolUses) {
      if (o.send) o.send({ type: "tool", name: tu.name });
      const before = o.ctx.actions.length;
      const r = await runTool(o.ctx, tu.name, tu.input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
      if (o.send) for (const a of o.ctx.actions.slice(before)) o.send({ type: "action", action: a });
    }
    o.messages.push({ role: "user", content: results });   // all results in one message
  }
  return { text: text.trim(), usage, refused, truncated };
}

function errorMessage(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Claude API key was rejected. Check the ANTHROPIC_API_KEY secret.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy right now. Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return "Claude couldn't accept that request. If your API credit ran out, add credit and try again.";
  if (e instanceof Anthropic.APIError) return `Claude returned an error (${e.status ?? "network"}). Try again.`;
  return "Something went wrong on the server. Try again.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  // Who is calling? Everything below runs as that user, so Row Level Security applies.
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const sb = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth } = await sb.auth.getUser(token);
  const user = auth?.user;
  if (!user) return json(req, { error: "Sign in first." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: "Send JSON." }, 400); }
  const mode = String(body?.mode || "");
  const tz = safeTz(body?.tz);
  const today = todayIn(tz);
  const key = Deno.env.get("ANTHROPIC_API_KEY") || "";
  const ctx: Ctx = { sb, tz, today, source: mode === "chat" ? "agent" : "quicklog", messageId: null, actions: [] };

  try {
    if (mode === "ping") return json(req, { ai: !!key });

    if (mode === "undo") {
      const ids = Array.isArray(body.action_ids) ? body.action_ids.filter((x: unknown) => typeof x === "string").slice(0, 50) : [];
      return json(req, { undone: ids.length ? await undoActions(sb, ids) : 0 });
    }

    if (mode === "tools") {
      // Tool calls produced by the app's rule-based parser. Same validation and undo as the AI path.
      const calls = Array.isArray(body.calls) ? body.calls.slice(0, 20) : [];
      const results = [];
      for (const c of calls) results.push(await runTool(ctx, String(c?.name || ""), c?.input));
      return json(req, { ai: false, results, actions: ctx.actions });
    }

    if (mode !== "quicklog" && mode !== "chat") return json(req, { error: "Unknown mode." }, 400);
    const text = String(body.text || "").trim().slice(0, MAX_INPUT_CHARS);
    if (!text) return json(req, { error: "Empty message." }, 400);
    if (!key) return json(req, { ai: false });

    // Cost guard: stop using Claude once this month's spend reaches the budget.
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
    const monthStart = today.slice(0, 8) + "01";
    const [{ data: profile }, { data: spentRows }] = await Promise.all([
      sb.from("profile").select("monthly_budget_usd").maybeSingle(),
      admin.from("usage_log").select("cost_usd").eq("user_id", user.id).gte("created_at", monthStart + "T00:00:00Z").limit(10000),
    ]);
    const budget = Number(profile?.monthly_budget_usd ?? 5);
    const spent = (spentRows || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0);
    if (spent >= budget) return json(req, { ai: false, reason: "budget", spent: Math.round(spent * 100) / 100, budget });

    const client = new Anthropic({ apiKey: key });
    const context = await loadContext(sb, tz, today);
    const logUsage = async (kind: string, usage: Usage[]) => {
      if (!usage.length) return;
      await admin.from("usage_log").insert(usage.map((u) => ({ user_id: user.id, kind, model: u.model, input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite, cost_usd: costOf(u) })));
    };
    // Save both chat rows first: agent_actions rows point at the assistant message.
    ctx.messageId = crypto.randomUUID();
    await sb.from("messages").insert({ role: "user", content: text, meta: { mode } });
    await sb.from("messages").insert({ id: ctx.messageId, role: "assistant", content: "…", meta: { mode, pending: true } });
    const saveMessages = async (reply: string, meta: Record<string, unknown>) => {
      await sb.from("messages").update({ content: reply || "(no reply)", meta: { mode, ...meta } }).eq("id", ctx.messageId);
    };
    const contextMessage = { role: "user", content: `<context>\n${context}\n</context>` };

    if (mode === "quicklog") {
      const r = await agentLoop({ client, model: QUICK_MODEL, system: QUICKLOG_SYSTEM, tools: toolDefs(QUICK_TOOLS, false), maxTokens: QUICK_MAX_TOKENS, effort: "low", ctx,
        messages: [contextMessage, { role: "user", content: text }] });
      const reply = r.refused ? "I can't help with that one." : r.text || (ctx.actions.length ? "Saved." : "I couldn't find anything to save in that.");
      await saveMessages(reply, { model: QUICK_MODEL, actions: ctx.actions.map((a) => a.id) });
      await logUsage("quicklog", r.usage);
      return json(req, { ai: true, reply, actions: ctx.actions });
    }

    // chat: stream the reply as Server-Sent Events
    const history = (Array.isArray(body.history) ? body.history : []).slice(-12)
      .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_INPUT_CHARS) }));
    const messages = [contextMessage, ...history, { role: "user", content: text }];
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { /* client went away */ } };
        try {
          const r = await agentLoop({ client, model: COACH_MODEL, system: COACH_SYSTEM, tools: toolDefs(undefined, true), maxTokens: CHAT_MAX_TOKENS, effort: "low", ctx, messages, send });
          const reply = r.refused ? "I can't help with that one. Try asking in a different way." : r.text || (ctx.actions.length ? "Done." : "");
          if (r.refused || (!r.text && reply)) send({ type: "text", delta: reply, replace: r.refused });
          await saveMessages(reply, { model: COACH_MODEL, actions: ctx.actions.map((a) => a.id), refused: r.refused, truncated: r.truncated });
          await logUsage("coach", r.usage);
          send({ type: "done", reply, actions: ctx.actions, truncated: r.truncated, cost_usd: r.usage.reduce((s, u) => s + costOf(u), 0) });
        } catch (e) {
          console.error("chat failed", e);
          send({ type: "error", message: errorMessage(e), actions: ctx.actions });
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { ...cors(req), "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  } catch (e) {
    console.error("agent failed", e);
    return json(req, { error: errorMessage(e), actions: ctx.actions }, 500);
  }
});
