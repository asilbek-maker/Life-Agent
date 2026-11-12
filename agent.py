"""
Life Agent - a personal AI assistant for gym, study, work and everything else.

Talk to it in plain language:
    "did chest today, bench press 60kg 4x8"
    "studied math for 2 hours, finished chapter 5"
    "how much did I study this week?"
    "set a goal: bench 80kg by March"

Everything is saved to life_data.json next to this file.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

import anthropic

MODEL = "claude-opus-5-5"
DATA_FILE = Path(__file__).parent / "life_data.json"
CATEGORIES = ["gym", "study", "work", "health", "sleep", "mood", "other"]

SYSTEM_PROMPT = """You are Life Agent, a friendly personal assistant that helps the user track \
and improve their life: gym workouts, studying, work, health, sleep, mood and anything else.

How to behave:
- When the user tells you about something they did, save it with log_entry. Pick the best \
category, a short title, the duration in minutes if known, and put specifics (sets, reps, \
weights, subjects, pages, tasks) in details. If they mention several things, log each one.
- When they ask about their history or progress, use get_entries or get_stats before answering. \
Never invent past data.
- Help them set goals and check them off. Mention relevant open goals when it is encouraging.
- Keep replies short and natural, like a supportive friend or coach. Give a concrete tip or \
observation when it is useful, not every time.
- Use get_today to know the current date and time before reasoning about "today", "this week", etc."""


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def load_data() -> dict:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {"entries": [], "goals": []}


def save_data(data: dict) -> None:
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Tools (the things the agent can do)
# ---------------------------------------------------------------------------

def get_today() -> str:
    now = datetime.now()
    return now.strftime("%A, %Y-%m-%d %H:%M")


def log_entry(category: str, title: str, minutes: int | None = None,
              details: str = "", date: str | None = None) -> str:
    data = load_data()
    entry = {
        "id": len(data["entries"]) + 1,
        "date": date or datetime.now().strftime("%Y-%m-%d"),
        "logged_at": datetime.now().isoformat(timespec="seconds"),
        "category": category,
        "title": title,
        "minutes": minutes,
        "details": details,
    }
    data["entries"].append(entry)
    save_data(data)
    return f"Saved entry #{entry['id']}: {json.dumps(entry, ensure_ascii=False)}"


def get_entries(category: str | None = None, days: int = 7) -> str:
    data = load_data()
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = [e for e in data["entries"]
            if e["date"] >= since and (category is None or e["category"] == category)]
    if not rows:
        return f"No entries found in the last {days} days" + (f" for {category}." if category else ".")
    return json.dumps(rows, indent=1, ensure_ascii=False)


def get_stats(days: int = 7) -> str:
    data = load_data()
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    stats: dict[str, dict] = {}
    for e in data["entries"]:
        if e["date"] < since:
            continue
        s = stats.setdefault(e["category"], {"sessions": 0, "total_minutes": 0, "active_days": set()})
        s["sessions"] += 1
        s["total_minutes"] += e["minutes"] or 0
        s["active_days"].add(e["date"])
    if not stats:
        return f"No activity in the last {days} days."
    result = {cat: {"sessions": s["sessions"],
                    "total_hours": round(s["total_minutes"] / 60, 1),
                    "active_days": len(s["active_days"])}
              for cat, s in stats.items()}
    return f"Stats for the last {days} days: " + json.dumps(result)


def add_goal(category: str, goal: str, deadline: str | None = None) -> str:
    data = load_data()
    g = {"id": len(data["goals"]) + 1, "category": category, "goal": goal,
         "deadline": deadline, "created": datetime.now().strftime("%Y-%m-%d"), "done": False}
    data["goals"].append(g)
    save_data(data)
    return f"Goal #{g['id']} added: {goal}"


def list_goals(include_done: bool = False) -> str:
    goals = [g for g in load_data()["goals"] if include_done or not g["done"]]
    return json.dumps(goals, indent=1, ensure_ascii=False) if goals else "No goals yet."


def complete_goal(goal_id: int) -> str:
    data = load_data()
    for g in data["goals"]:
        if g["id"] == goal_id:
            g["done"] = True
            g["completed"] = datetime.now().strftime("%Y-%m-%d")
            save_data(data)
            return f"Goal #{goal_id} marked complete: {g['goal']}"
    return f"No goal with id {goal_id}."


TOOL_FUNCTIONS = {
    "get_today": get_today,
    "log_entry": log_entry,
    "get_entries": get_entries,
    "get_stats": get_stats,
    "add_goal": add_goal,
    "list_goals": list_goals,
    "complete_goal": complete_goal,
}

TOOLS = [
    {
        "name": "get_today",
        "description": "Get the current date, weekday and time.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "log_entry",
        "description": "Save something the user did (a workout, study session, work task, sleep, mood, etc.).",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": CATEGORIES},
                "title": {"type": "string", "description": "Short title, e.g. 'Chest day' or 'Math - chapter 5'."},
                "minutes": {"type": "integer", "description": "Duration in minutes, if known."},
                "details": {"type": "string", "description": "Specifics: exercises/sets/reps/weights, topics, tasks, notes."},
                "date": {"type": "string", "description": "YYYY-MM-DD if not today (e.g. 'yesterday')."},
            },
            "required": ["category", "title"],
        },
    },
    {
        "name": "get_entries",
        "description": "Get the user's logged entries from the last N days, optionally for one category.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": CATEGORIES},
                "days": {"type": "integer", "description": "How many days back to look. Default 7."},
            },
        },
    },
    {
        "name": "get_stats",
        "description": "Get totals per category (sessions, hours, active days) for the last N days.",
        "input_schema": {
            "type": "object",
            "properties": {"days": {"type": "integer", "description": "Default 7."}},
        },
    },
    {
        "name": "add_goal",
        "description": "Add a personal goal.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": CATEGORIES},
                "goal": {"type": "string"},
                "deadline": {"type": "string", "description": "YYYY-MM-DD, optional."},
            },
            "required": ["category", "goal"],
        },
    },
    {
        "name": "list_goals",
        "description": "List the user's goals.",
        "input_schema": {
            "type": "object",
            "properties": {"include_done": {"type": "boolean", "description": "Also show completed goals."}},
        },
    },
    {
        "name": "complete_goal",
        "description": "Mark a goal as completed by its id.",
        "input_schema": {
            "type": "object",
            "properties": {"goal_id": {"type": "integer"}},
            "required": ["goal_id"],
        },
    },
]


def run_tool(name: str, tool_input: dict) -> tuple[str, bool]:
    """Run a tool. Returns (result_text, is_error)."""
    try:
        return str(TOOL_FUNCTIONS[name](**tool_input)), False
    except Exception as e:  # report the problem back to Claude instead of crashing
        return f"Error running {name}: {e}", True


# ---------------------------------------------------------------------------
# The agent loop
# ---------------------------------------------------------------------------

def ask_claude(client: anthropic.Anthropic, messages: list):
    return client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        messages=messages,
        output_config={"effort": "medium"},
        # If a request is ever declined by a safety check, retry it on a fallback model.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )


def agent_turn(client: anthropic.Anthropic, messages: list) -> str:
    """Let Claude think, call tools as many times as it needs, then return its reply."""
    while True:
        response = ask_claude(client, messages)
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "refusal":
            return "(Sorry, I can't help with that one.)"

        if response.stop_reason != "tool_use":
            return "".join(b.text for b in response.content if b.type == "text")

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result, is_error = run_tool(block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                    "is_error": is_error,
                })
        messages.append({"role": "user", "content": tool_results})


def main() -> None:
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    messages: list = []

    print("Life Agent - tell me about your day (gym, study, work, anything). Type 'quit' to exit.\n")
    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if user_input.lower() in {"quit", "exit", "q"}:
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})
        try:
            reply = agent_turn(client, messages)
        except anthropic.AuthenticationError:
            print("\nAgent: Your API key is missing or wrong. Set ANTHROPIC_API_KEY and try again.\n")
            messages.pop()
            continue
        except anthropic.APIConnectionError:
            print("\nAgent: I couldn't reach the Claude API. Check your internet connection.\n")
            messages.pop()
            continue
        except anthropic.APIStatusError as e:
            print(f"\nAgent: The API returned an error ({e.status_code}): {e.message}\n")
            messages.pop()
            continue
        print(f"\nAgent: {reply}\n")

    print("Bye! Keep it up.")


if __name__ == "__main__":
    main()
