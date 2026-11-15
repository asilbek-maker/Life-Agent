// The agent's tools. Each tool has a JSON schema (what Claude sees), a Zod schema
// (what we actually accept) and a run function that works on the user's own rows.
// Every write is recorded in agent_actions so the app can offer "Undo".
import { z } from "npm:zod@3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type ActionOut = { id: string; tool: string; table: string; op: string; label: string };
export type Ctx = {
  sb: SupabaseClient;          // signed in as the user, so Row Level Security applies
  tz: string;
  today: string;               // YYYY-MM-DD in the user's timezone
  source: "agent" | "quicklog";
  messageId: string | null;
  actions: ActionOut[];
};

// ---------- dates ----------
const pad = (n: number) => String(n).padStart(2, "0");
export const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (s: string) => new Date(s + "T12:00:00Z").getUTCDay();

function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - at.getTime();
}
// A wall-clock date and time in a timezone -> the UTC instant.
export function wallToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number), [h, mi] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return new Date(guess - tzOffsetMs(tz, new Date(guess)));
}
export function safeTz(tz: unknown): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return String(tz); } catch { return "UTC"; }
}
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function nextDue(r: { time: string; repeat: string; start_date: string }, tz: string, now = new Date()): string | null {
  if (r.repeat === "once") { const d = wallToUtc(r.start_date, r.time, tz); return d > now ? d.toISOString() : null; }
  const today = todayIn(tz, now), start = r.start_date > today ? r.start_date : today;
  for (let i = 0; i < 8; i++) {
    const day = addDays(start, i), wd = weekday(day);
    if (r.repeat === "weekdays" && (wd === 0 || wd === 6)) continue;
    if (r.repeat === "weekly" && wd !== weekday(r.start_date)) continue;
    const d = wallToUtc(day, r.time, tz);
    if (d > now) return d.toISOString();
  }
  return null;
}

// ---------- shared pieces ----------
const AREAS = ["gym", "study", "work", "health", "mood", "other"] as const;
const MOOD_LABEL: Record<number, string> = { 1: "Rough", 2: "Low", 3: "Okay", 4: "Good", 5: "Great" };
const AREA_LABEL: Record<string, string> = { gym: "Gym", study: "Study", work: "Work", health: "Health", mood: "Mood", other: "Other" };
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM");
const zId = z.string().uuid();
const zArea = z.enum(AREAS);
const zRepeat = z.enum(["once", "daily", "weekdays", "weekly"]);
const round1 = (n: number) => Math.round(n * 10) / 10;

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

function entryLabel(e: any): string {
  const d = e.data || {}, bits: string[] = [];
  if (e.area === "gym") { if (d.sets && d.reps) bits.push(`${d.sets} × ${d.reps}`); if (typeof d.weight === "number") bits.push(`${d.weight} kg`); }
  if (e.area === "mood" && d.score) bits.push(`${d.score}/5`);
  if (e.minutes) bits.push(e.minutes >= 90 ? `${round1(e.minutes / 60)} h` : `${e.minutes} min`);
  return `${AREA_LABEL[e.area] || e.area}: ${e.title}${bits.length ? " · " + bits.join(" · ") : ""}`;
}
const repeatLabel: Record<string, string> = { once: "once", daily: "every day", weekdays: "weekdays", weekly: "every week" };

async function record(ctx: Ctx, tool: string, table: string, rowId: string, op: "insert" | "update" | "delete", before: unknown, after: unknown, label: string) {
  const row = must(await ctx.sb.from("agent_actions").insert({ message_id: ctx.messageId, tool, table_name: table, row_id: rowId, op, before, after }).select("id").single());
  ctx.actions.push({ id: (row as any).id, tool, table, op, label });
}
async function getRow(ctx: Ctx, table: string, id: string) {
  const row = must(await ctx.sb.from(table).select("*").eq("id", id).is("deleted_at", null).maybeSingle());
  if (!row) throw new Error(`No ${table.replace(/s$/, "")} with that id.`);
  return row as any;
}

// Same shapes the app's own forms save.
const EntryFields = {
  title: z.string().max(120).nullish(),
  date: zDate.nullish(),
  minutes: z.number().min(0).max(1440).nullish(),
  details: z.string().max(500).nullish(),
  exercise: z.string().max(80).nullish(),
  sets: z.number().int().min(1).max(30).nullish(),
  reps: z.number().int().min(0).max(1000).nullish(),
  weight: z.number().min(0).max(1000).nullish(),
  subject: z.string().max(80).nullish(),
  status: z.enum(["done", "in progress", "blocked"]).nullish(),
  sleepHours: z.number().min(0).max(24).nullish(),
  water: z.number().min(0).max(60).nullish(),
  score: z.number().int().min(1).max(5).nullish(),
};
function buildEntry(area: string, f: any, base?: any) {
  const data: any = { ...(base?.data || {}) };
  let title = String(f.title ?? "").trim();
  if (area === "gym") {
    if (f.exercise != null || !data.exercise) data.exercise = String(f.exercise || title || data.exercise || "Workout").trim();
    for (const k of ["sets", "reps", "weight"]) if (f[k] != null) data[k] = f[k];
    if (f.sets != null || f.reps != null || f.weight != null) delete data.setLog;
    title = title || data.exercise;
  } else if (area === "study") {
    if (f.subject != null || !data.subject) data.subject = String(f.subject || title || data.subject || "Study").trim();
    title = title || data.subject;
  } else if (area === "work") {
    data.status = f.status ?? data.status ?? "done";
    title = title || base?.title || "Work";
  } else if (area === "health") {
    if (f.sleepHours != null) data.sleepHours = f.sleepHours;
    if (f.water != null) data.water = f.water;
    const parts: string[] = [];
    if (typeof data.sleepHours === "number") parts.push(`Slept ${data.sleepHours} h`);
    if (typeof data.water === "number") parts.push(`${data.water} glasses of water`);
    title = title || parts.join(", ") || "Health check-in";
  } else if (area === "mood") {
    if (f.score != null) data.score = f.score;
    if (!data.score) data.score = 3;
    title = title || MOOD_LABEL[data.score];
  }
  return { title: title || base?.title || "Entry", data };
}

// ---------- tools ----------
type Tool = { name: string; description: string; input_schema: Record<string, unknown>; schema: z.ZodTypeAny; write: boolean; run: (ctx: Ctx, input: any) => Promise<unknown> };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const P = {
  area: { type: "string", enum: [...AREAS], description: "Which part of the app it belongs to." },
  date: { type: "string", description: "YYYY-MM-DD. Omit for today." },
  id: { type: "string", description: "The row's id (a UUID from an earlier tool result or the context)." },
};
const entryProps = {
  title: { type: "string", description: "Short title. Optional for gym (uses exercise) and study (uses subject)." },
  date: P.date,
  minutes: { type: "number", description: "Duration in minutes." },
  details: { type: "string", description: "Extra notes." },
  exercise: { type: "string", description: "Gym: exercise name, e.g. Bench press." },
  sets: { type: "integer" }, reps: { type: "integer" }, weight: { type: "number", description: "Gym: weight in kg." },
  subject: { type: "string", description: "Study: subject." },
  status: { type: "string", enum: ["done", "in progress", "blocked"], description: "Work: task status." },
  sleepHours: { type: "number", description: "Health: hours slept." },
  water: { type: "number", description: "Health: glasses of water." },
  score: { type: "integer", description: "Mood: 1 (rough) to 5 (great)." },
};

export const TOOLS: Tool[] = [
  {
    name: "log_entry", write: true,
    description: "Save one activity the user did. One call per activity; each gym exercise is its own entry. Returns the saved entry with its id.",
    input_schema: obj({ area: P.area, ...entryProps }, ["area"]),
    schema: z.object({ area: zArea, ...EntryFields }),
    async run(ctx, i) {
      const { title, data } = buildEntry(i.area, i);
      const row = { id: crypto.randomUUID(), area: i.area, date: i.date || ctx.today, title, minutes: i.minutes != null ? Math.round(i.minutes) : null, details: String(i.details || "").trim(), data, source: ctx.source };
      const saved = must(await ctx.sb.from("entries").insert(row).select("*").single()) as any;
      await record(ctx, "log_entry", "entries", saved.id, "insert", null, saved, entryLabel(saved));
      return { saved: true, id: saved.id, area: saved.area, date: saved.date, title: saved.title, minutes: saved.minutes, data: saved.data };
    },
  },
  {
    name: "update_entry", write: true,
    description: "Change an entry that already exists (fix a weight, a date, minutes, a note). Only pass the fields that change.",
    input_schema: obj({ id: P.id, ...entryProps }, ["id"]),
    schema: z.object({ id: zId, ...EntryFields }),
    async run(ctx, i) {
      const before = await getRow(ctx, "entries", i.id);
      const { title, data } = buildEntry(before.area, { ...i, title: i.title ?? before.title }, before);
      const patch: any = { title, data };
      if (i.date) patch.date = i.date;
      if (i.minutes != null) patch.minutes = Math.round(i.minutes);
      if (i.details != null) patch.details = i.details;
      const after = must(await ctx.sb.from("entries").update(patch).eq("id", i.id).select("*").single()) as any;
      await record(ctx, "update_entry", "entries", i.id, "update", before, after, "Updated " + entryLabel(after));
      return { updated: true, id: after.id, date: after.date, title: after.title, minutes: after.minutes, data: after.data };
    },
  },
  {
    name: "delete_entry", write: true,
    description: "Delete an entry by id. Use it only when the user asks to remove something.",
    input_schema: obj({ id: P.id }, ["id"]),
    schema: z.object({ id: zId }),
    async run(ctx, i) {
      const before = await getRow(ctx, "entries", i.id);
      must(await ctx.sb.from("entries").update({ deleted_at: new Date().toISOString() }).eq("id", i.id));
      await record(ctx, "delete_entry", "entries", i.id, "delete", before, null, "Deleted " + entryLabel(before));
      return { deleted: true, title: before.title };
    },
  },
  {
    name: "query_entries", write: false,
    description: "Read logged entries, newest first. Filter by area and by the last N days or a from/to date range. Returns up to `limit` entries with their ids.",
    input_schema: obj({ area: P.area, days: { type: "integer", description: "Look back this many days (default 7)." }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, limit: { type: "integer", description: "Default 50, max 200." } }),
    schema: z.object({ area: zArea.nullish(), days: z.number().int().min(1).max(3660).nullish(), from: zDate.nullish(), to: zDate.nullish(), limit: z.number().int().min(1).max(200).nullish() }),
    async run(ctx, i) {
      const from = i.from || addDays(ctx.today, -((i.days || 7) - 1)), to = i.to || ctx.today;
      let q = ctx.sb.from("entries").select("id,area,date,title,minutes,details,data").is("deleted_at", null).gte("date", from).lte("date", to).order("date", { ascending: false }).order("created_at", { ascending: false }).limit(i.limit || 50);
      if (i.area) q = q.eq("area", i.area);
      const rows = must(await q) as any[];
      return rows.length ? rows : `No entries between ${from} and ${to}${i.area ? " for " + i.area : ""}.`;
    },
  },
  {
    name: "get_personal_records", write: false,
    description: "The user's heaviest weight for each gym exercise, with the date and reps. Optionally for one exercise.",
    input_schema: obj({ exercise: { type: "string", description: "Only this exercise (matches by name)." } }),
    schema: z.object({ exercise: z.string().max(80).nullish() }),
    async run(ctx, i) { return await personalRecords(ctx.sb, i.exercise); },
  },
  {
    name: "get_week_summary", write: false,
    description: "Totals for one week (Monday to Sunday): gym days and exercises, study and work hours, average sleep, water and mood, goals completed. week_offset 0 is this week, -1 last week.",
    input_schema: obj({ week_offset: { type: "integer", description: "0 = this week, -1 = last week." } }),
    schema: z.object({ week_offset: z.number().int().min(-520).max(0).nullish() }),
    async run(ctx, i) {
      const monday = addDays(ctx.today, -((weekday(ctx.today) + 6) % 7) + 7 * (i.week_offset || 0));
      return await rangeSummary(ctx.sb, monday, addDays(monday, 6));
    },
  },
  {
    name: "get_mood_patterns", write: false,
    description: "How the user's mood relates to their days: average by weekday, on gym days vs other days, and after 7+ hours of sleep vs less. Looks back N days (default 30).",
    input_schema: obj({ days: { type: "integer", description: "Default 30." } }),
    schema: z.object({ days: z.number().int().min(7).max(366).nullish() }),
    async run(ctx, i) {
      const from = addDays(ctx.today, -((i.days || 30) - 1));
      const rows = must(await ctx.sb.from("entries").select("area,date,data").is("deleted_at", null).gte("date", from).in("area", ["mood", "gym", "health"]).limit(3000)) as any[];
      const moodBy: Record<string, number[]> = {}, gymDays = new Set<string>(), sleepBy: Record<string, number> = {};
      for (const r of rows) {
        if (r.area === "mood" && typeof r.data?.score === "number") (moodBy[r.date] ||= []).push(r.data.score);
        if (r.area === "gym") gymDays.add(r.date);
        if (r.area === "health" && typeof r.data?.sleepHours === "number") sleepBy[r.date] = r.data.sleepHours;
      }
      const days = Object.entries(moodBy).map(([date, v]) => ({ date, mood: v.reduce((a, b) => a + b, 0) / v.length }));
      if (days.length < 3) return `Only ${days.length} day(s) with a mood logged since ${from}. Not enough to see a pattern yet.`;
      const avg = (xs: number[]) => xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
      const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const byWeekday: Record<string, number | null> = {};
      for (let w = 0; w < 7; w++) { const xs = days.filter((d) => weekday(d.date) === w).map((d) => d.mood); if (xs.length) byWeekday[names[w]] = avg(xs); }
      return {
        days_with_mood: days.length, average: avg(days.map((d) => d.mood)), by_weekday: byWeekday,
        on_gym_days: avg(days.filter((d) => gymDays.has(d.date)).map((d) => d.mood)), on_other_days: avg(days.filter((d) => !gymDays.has(d.date)).map((d) => d.mood)),
        after_7h_or_more_sleep: avg(days.filter((d) => sleepBy[d.date] >= 7).map((d) => d.mood)), after_less_than_7h_sleep: avg(days.filter((d) => sleepBy[d.date] < 7).map((d) => d.mood)),
        best_day: days.reduce((a, b) => (b.mood > a.mood ? b : a)), hardest_day: days.reduce((a, b) => (b.mood < a.mood ? b : a)),
      };
    },
  },
  {
    name: "create_goal", write: true,
    description: "Add a personal goal. Give target_value and unit when the goal is a number to reach (e.g. 80 kg). Returns the goal with its id.",
    input_schema: obj({ text: { type: "string" }, area: P.area, deadline: { type: "string", description: "YYYY-MM-DD, optional." }, target_value: { type: "number" }, unit: { type: "string", description: "e.g. kg, hours, books" } }, ["text"]),
    schema: z.object({ text: z.string().min(1).max(200), area: zArea.nullish(), deadline: zDate.nullish(), target_value: z.number().nullish(), unit: z.string().max(20).nullish() }),
    async run(ctx, i) {
      const saved = must(await ctx.sb.from("goals").insert({ id: crypto.randomUUID(), area: i.area || "other", text: i.text.trim(), deadline: i.deadline || null, target_value: i.target_value ?? null, unit: i.unit ?? null }).select("*").single()) as any;
      await record(ctx, "create_goal", "goals", saved.id, "insert", null, saved, `Goal: ${saved.text}`);
      return { added: true, id: saved.id, text: saved.text, deadline: saved.deadline };
    },
  },
  {
    name: "update_goal_progress", write: true,
    description: "Record how far along a numeric goal is (current_value, in the goal's unit).",
    input_schema: obj({ id: P.id, current_value: { type: "number" } }, ["id", "current_value"]),
    schema: z.object({ id: zId, current_value: z.number() }),
    async run(ctx, i) {
      const before = await getRow(ctx, "goals", i.id);
      const after = must(await ctx.sb.from("goals").update({ current_value: i.current_value }).eq("id", i.id).select("*").single()) as any;
      await record(ctx, "update_goal_progress", "goals", i.id, "update", before, after, `Goal progress: ${after.text} → ${i.current_value}${after.unit ? " " + after.unit : ""}`);
      return { updated: true, text: after.text, current_value: after.current_value, target_value: after.target_value, unit: after.unit };
    },
  },
  {
    name: "complete_goal", write: true,
    description: "Mark an open goal as completed.",
    input_schema: obj({ id: P.id }, ["id"]),
    schema: z.object({ id: zId }),
    async run(ctx, i) {
      const before = await getRow(ctx, "goals", i.id);
      const after = must(await ctx.sb.from("goals").update({ done: true, completed_on: ctx.today }).eq("id", i.id).select("*").single()) as any;
      await record(ctx, "complete_goal", "goals", i.id, "update", before, after, `Goal completed: ${after.text}`);
      return { completed: true, text: after.text };
    },
  },
  {
    name: "create_reminder", write: true,
    description: "Create a reminder that notifies the user. time is 24-hour HH:MM in their local time. For 'once', date is the day; for repeating ones, date is the first day (omit for today).",
    input_schema: obj({ text: { type: "string", description: "What to remind, e.g. 'Go to the gym'." }, time: { type: "string", description: "24-hour HH:MM, e.g. 07:30." }, repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekly"] }, date: P.date, area: P.area }, ["text", "time", "repeat"]),
    schema: z.object({ text: z.string().min(1).max(200), time: zTime, repeat: zRepeat, date: zDate.nullish(), area: zArea.nullish() }),
    async run(ctx, i) {
      const start_date = i.date || ctx.today;
      const row = { id: crypto.randomUUID(), text: i.text.trim(), area: i.area || "other", time_of_day: i.time, repeat: i.repeat, start_date, timezone: ctx.tz, next_due_at: nextDue({ time: i.time, repeat: i.repeat, start_date }, ctx.tz), active: true };
      const saved = must(await ctx.sb.from("reminders").insert(row).select("*").single()) as any;
      await record(ctx, "create_reminder", "reminders", saved.id, "insert", null, saved, `Reminder: ${saved.text}, ${repeatLabel[saved.repeat]} at ${i.time}`);
      return { saved: true, id: saved.id, text: saved.text, time: i.time, repeat: saved.repeat, first_date: start_date, next_due_at: saved.next_due_at };
    },
  },
  {
    name: "update_reminder", write: true,
    description: "Change a reminder: its text, time, repeat, date, or switch it off with active=false. Only pass what changes.",
    input_schema: obj({ id: P.id, text: { type: "string" }, time: { type: "string", description: "24-hour HH:MM" }, repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekly"] }, date: P.date, active: { type: "boolean" } }, ["id"]),
    schema: z.object({ id: zId, text: z.string().min(1).max(200).nullish(), time: zTime.nullish(), repeat: zRepeat.nullish(), date: zDate.nullish(), active: z.boolean().nullish() }),
    async run(ctx, i) {
      const before = await getRow(ctx, "reminders", i.id);
      const time = i.time || String(before.time_of_day).slice(0, 5), repeat = i.repeat || before.repeat, start_date = i.date || before.start_date, active = i.active ?? before.active;
      const patch = { text: i.text?.trim() || before.text, time_of_day: time, repeat, start_date, active, timezone: ctx.tz, next_due_at: active ? nextDue({ time, repeat, start_date }, ctx.tz) : null };
      const after = must(await ctx.sb.from("reminders").update(patch).eq("id", i.id).select("*").single()) as any;
      await record(ctx, "update_reminder", "reminders", i.id, "update", before, after, `Reminder updated: ${after.text}, ${repeatLabel[after.repeat]} at ${time}${active ? "" : " (off)"}`);
      return { updated: true, text: after.text, time, repeat, active, next_due_at: after.next_due_at };
    },
  },
  {
    name: "delete_reminder", write: true,
    description: "Delete a reminder by id.",
    input_schema: obj({ id: P.id }, ["id"]),
    schema: z.object({ id: zId }),
    async run(ctx, i) {
      const before = await getRow(ctx, "reminders", i.id);
      must(await ctx.sb.from("reminders").update({ deleted_at: new Date().toISOString() }).eq("id", i.id));
      await record(ctx, "delete_reminder", "reminders", i.id, "delete", before, null, `Reminder deleted: ${before.text}`);
      return { deleted: true, text: before.text };
    },
  },
  {
    name: "create_plan", write: true,
    description: "Replace the user's weekly gym plan. days are the sessions in the order to do them. Each exercise has sets, a rep range (repMin-repMax), rest in seconds, an optional startWeight in kg and one short form cue in notes.",
    input_schema: obj({
      name: { type: "string" },
      days: { type: "array", items: obj({ name: { type: "string" }, focus: { type: "string" },
        exercises: { type: "array", items: obj({ name: { type: "string" }, sets: { type: "integer" }, repMin: { type: "integer" }, repMax: { type: "integer" }, rest: { type: "integer", description: "seconds" }, startWeight: { type: ["number", "null"] }, notes: { type: "string" } }, ["name", "sets", "repMin", "repMax"]) } }, ["name", "exercises"]) },
    }, ["name", "days"]),
    schema: z.object({
      name: z.string().min(1).max(60),
      days: z.array(z.object({
        name: z.string().min(1).max(60), focus: z.string().max(100).nullish(),
        exercises: z.array(z.object({ name: z.string().min(1).max(60), sets: z.number().int().min(1).max(8), repMin: z.number().int().min(1).max(600), repMax: z.number().int().min(1).max(600), rest: z.number().int().min(15).max(600).nullish(), startWeight: z.number().min(0).max(500).nullish(), notes: z.string().max(160).nullish() })).min(1).max(12),
      })).min(1).max(7),
    }),
    async run(ctx, i) {
      const days = i.days.map((d: any) => ({ name: d.name, focus: d.focus || "", exercises: d.exercises.map((x: any) => ({ name: x.name, sets: x.sets, repMin: Math.min(x.repMin, x.repMax), repMax: Math.max(x.repMin, x.repMax), rest: x.rest ?? 90, startWeight: x.startWeight ?? null, notes: x.notes || "" })) }));
      const old = must(await ctx.sb.from("plans").select("*").eq("active", true).is("deleted_at", null)) as any[];
      for (const p of old) {
        const after = must(await ctx.sb.from("plans").update({ active: false }).eq("id", p.id).select("*").single());
        await record(ctx, "create_plan", "plans", p.id, "update", p, after, `Old plan put away: ${p.name}`);
      }
      const saved = must(await ctx.sb.from("plans").insert({ id: crypto.randomUUID(), name: i.name, settings: old[0]?.settings || {}, days, next_day: 0, active: true }).select("*").single()) as any;
      await record(ctx, "create_plan", "plans", saved.id, "insert", null, saved, `New plan: ${saved.name} (${days.length} days)`);
      return { saved: true, id: saved.id, name: saved.name, days: days.map((d: any) => `${d.name}: ${d.exercises.length} exercises`) };
    },
  },
];

// streaming=true turns on eager input streaming, so tool inputs arrive as they are written.
// The API then no longer validates them; runTool's Zod check does.
export const toolDefs = (names?: string[], streaming = false) => TOOLS.filter((t) => !names || names.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(streaming ? { eager_input_streaming: true } : {}) }));

// Validate with Zod, then run. Returns the text for the tool_result block.
export async function runTool(ctx: Ctx, name: string, input: unknown): Promise<{ ok: boolean; content: string }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, content: `Unknown tool: ${name}` };
  const parsed = tool.schema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, content: "Invalid input: " + parsed.error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ") };
  try {
    const out = await tool.run(ctx, parsed.data);
    return { ok: true, content: typeof out === "string" ? out : JSON.stringify(out) };
  } catch (e) {
    return { ok: false, content: "Error: " + (e instanceof Error ? e.message : String(e)) };
  }
}

// ---------- summaries shared with the context loader ----------
export async function personalRecords(sb: SupabaseClient, exercise?: string | null) {
  const rows = must(await sb.from("entries").select("date,title,data").eq("area", "gym").is("deleted_at", null).order("date", { ascending: false }).limit(3000)) as any[];
  const best: Record<string, { exercise: string; weight: number; reps: number | null; date: string }> = {};
  for (const r of rows) {
    const name = String(r.data?.exercise || r.title || "").trim(); if (!name) continue;
    const sets = Array.isArray(r.data?.setLog) && r.data.setLog.length ? r.data.setLog : [{ w: r.data?.weight, r: r.data?.reps }];
    for (const s of sets) {
      if (typeof s.w !== "number") continue;
      const k = name.toLowerCase();
      if (!best[k] || s.w > best[k].weight) best[k] = { exercise: name, weight: s.w, reps: typeof s.r === "number" ? s.r : null, date: r.date };
    }
  }
  let list = Object.values(best).sort((a, b) => b.weight - a.weight);
  if (exercise) { const q = exercise.toLowerCase(); list = list.filter((x) => x.exercise.toLowerCase().includes(q) || q.includes(x.exercise.toLowerCase())); }
  return list.length ? list.slice(0, 40) : (exercise ? `No weights logged for ${exercise} yet.` : "No weights logged yet.");
}

export async function rangeSummary(sb: SupabaseClient, from: string, to: string) {
  const rows = must(await sb.from("entries").select("area,date,title,minutes,data").is("deleted_at", null).gte("date", from).lte("date", to).limit(3000)) as any[];
  const by = (a: string) => rows.filter((r) => r.area === a);
  const sum = (xs: any[]) => xs.reduce((s, r) => s + (r.minutes || 0), 0);
  const nums = (xs: any[], f: (r: any) => unknown) => xs.map(f).filter((v): v is number => typeof v === "number");
  const avg = (xs: number[]) => xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const subjects: Record<string, number> = {};
  for (const r of by("study")) { const k = r.data?.subject || r.title; subjects[k] = (subjects[k] || 0) + (r.minutes || 0); }
  const goals = must(await sb.from("goals").select("text").is("deleted_at", null).eq("done", true).gte("completed_on", from).lte("completed_on", to)) as any[];
  return {
    from, to, days_with_any_log: new Set(rows.map((r) => r.date)).size,
    gym: { training_days: new Set(by("gym").map((r) => r.date)).size, exercises: by("gym").length, hours: round1(sum(by("gym")) / 60) },
    study: { hours: round1(sum(by("study")) / 60), sessions: by("study").length, by_subject_hours: Object.fromEntries(Object.entries(subjects).map(([k, m]) => [k, round1(m / 60)])) },
    work: { hours: round1(sum(by("work")) / 60), tasks: by("work").length, done: by("work").filter((r) => r.data?.status === "done").length },
    health: { avg_sleep_hours: avg(nums(by("health"), (r) => r.data?.sleepHours)), avg_water_glasses: avg(nums(by("health"), (r) => r.data?.water)) },
    mood: { average: avg(nums(by("mood"), (r) => r.data?.score)), check_ins: by("mood").length },
    goals_completed: goals.map((g) => g.text),
  };
}

// ---------- undo ----------
// Reverses agent writes, newest first. Returns how many were undone.
export async function undoActions(sb: SupabaseClient, ids: string[]): Promise<number> {
  const rows = must(await sb.from("agent_actions").select("*").in("id", ids).is("undone_at", null).order("created_at", { ascending: false })) as any[];
  let n = 0;
  for (const a of rows) {
    if (a.op === "insert") must(await sb.from(a.table_name).update({ deleted_at: new Date().toISOString() }).eq("id", a.row_id));
    else if (a.op === "delete") must(await sb.from(a.table_name).update({ deleted_at: null }).eq("id", a.row_id));
    else if (a.op === "update" && a.before) {
      const { id: _id, user_id: _u, created_at: _c, updated_at: _up, ...fields } = a.before;
      must(await sb.from(a.table_name).update(fields).eq("id", a.row_id));
    }
    must(await sb.from("agent_actions").update({ undone_at: new Date().toISOString() }).eq("id", a.id));
    n++;
  }
  return n;
}
