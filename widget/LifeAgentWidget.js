// Life Agent widget for Scriptable (free on the App Store: https://scriptable.app)
// Shows today's date, your next calendar events and buttons that open Life Agent.
// Works in small, medium and large widgets, and inside a Smart Stack.

const APP = "https://asilbek-maker.github.io/Life-Agent/";

const C = {
  bg1: new Color("#1E2850"),
  bg2: new Color("#2B3A70"),
  text: Color.white(),
  dim: new Color("#FFFFFF", 0.7),
  chip: new Color("#FFFFFF", 0.12),
  gym: new Color("#FF7A5C"),
  study: new Color("#6F9BFF"),
  goals: new Color("#F27AB0"),
  health: new Color("#45C98F"),
};

// [label, SF Symbol, color, section]
const LINKS = [
  ["Gym", "dumbbell.fill", C.gym, "#gym"],
  ["Study", "book.fill", C.study, "#study"],
  ["Reminders", "bell.fill", C.goals, "#reminders"],
  ["Reports", "chart.bar.fill", C.health, "#reports"],
];

function symbol(name) {
  const s = SFSymbol.named(name) || SFSymbol.named("circle.fill");
  return s.image;
}

function time(d) {
  const f = new DateFormatter();
  f.useNoDateStyle();
  f.useShortTimeStyle();
  return f.string(d);
}

// Next events from the iPhone calendar (this includes Google Calendar if it's
// added in Settings > Calendar > Accounts). Asks for permission the first time.
async function nextEvents(count) {
  try {
    const now = new Date();
    const events = await CalendarEvent.today([]);
    return events
      .filter((e) => !e.isAllDay && e.endDate > now)
      .sort((a, b) => a.startDate - b.startDate)
      .slice(0, count);
  } catch (e) {
    return [];
  }
}

async function build() {
  const family = config.widgetFamily || "medium";
  const small = family === "small";
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [C.bg1, C.bg2];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 14, 14, 14);
  w.url = APP + "#home";
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  // Header: name and date
  const head = w.addStack();
  head.centerAlignContent();
  const title = head.addText("Life Agent");
  title.font = Font.boldSystemFont(small ? 14 : 16);
  title.textColor = C.text;
  head.addSpacer();
  const df = new DateFormatter();
  df.dateFormat = small ? "EEE d" : "EEEE, d MMM";
  const date = head.addText(df.string(new Date()));
  date.font = Font.mediumSystemFont(12);
  date.textColor = C.dim;

  w.addSpacer(8);

  const events = await nextEvents(family === "large" ? 5 : 2);

  if (small) {
    const e = events[0];
    const line = w.addText(e ? `${time(e.startDate)}  ${e.title}` : "Tap to log your day");
    line.font = Font.semiboldSystemFont(13);
    line.textColor = C.text;
    line.lineLimit = 3;
    w.addSpacer();
    const row = w.addStack();
    for (const [, sym, color] of LINKS) {
      const img = row.addImage(symbol(sym));
      img.imageSize = new Size(18, 18);
      img.tintColor = color;
      row.addSpacer(10);
    }
    return w;
  }

  if (events.length) {
    for (const e of events) {
      const r = w.addText(`${time(e.startDate)}   ${e.title}`);
      r.font = Font.mediumSystemFont(13);
      r.textColor = C.text;
      r.lineLimit = 1;
      w.addSpacer(2);
    }
  } else {
    const r = w.addText("Nothing planned right now. Tap a button to start.");
    r.font = Font.mediumSystemFont(13);
    r.textColor = C.dim;
    r.lineLimit = 2;
  }

  w.addSpacer();

  // Buttons (medium and large widgets can have several tap targets)
  const row = w.addStack();
  row.spacing = 8;
  for (const [label, sym, color, hash] of LINKS) {
    const b = row.addStack();
    b.layoutVertically();
    b.centerAlignContent();
    b.backgroundColor = C.chip;
    b.cornerRadius = 12;
    b.setPadding(8, 6, 8, 6);
    b.size = new Size(0, 52);
    b.url = APP + hash;
    const top = b.addStack();
    top.addSpacer();
    const img = top.addImage(symbol(sym));
    img.imageSize = new Size(18, 18);
    img.tintColor = color;
    top.addSpacer();
    b.addSpacer(4);
    const lr = b.addStack();
    lr.addSpacer();
    const l = lr.addText(label);
    l.font = Font.semiboldSystemFont(11);
    l.textColor = C.text;
    l.lineLimit = 1;
    l.minimumScaleFactor = 0.7;
    lr.addSpacer();
  }
  return w;
}

const widget = await build();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
