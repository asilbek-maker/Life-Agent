# Life Agent

A personal life-tracking app with an AI coach. It tracks gym workouts, study sessions, work, health, mood, goals and reminders, and writes daily, weekly, monthly and yearly reports.

**Live app:** https://claude.ai/artifact/CS9V7jz2GnCzdtmcrd33Wr

## Features

- **Gym:** a personal training plan (built by AI or from a standard template), guided workouts with +/− steppers, a rest timer, automatic weight progression and PR tracking. There's also an exercise library of 105 exercises with start and finish photos and step-by-step instructions.
- **Study:** a Pomodoro timer where you set the focus time, break time and number of rounds, plus hours per subject.
- **Work, Health, Mood:** quick daily logs with weekly charts.
- **Goals and Reminders:** reminders can be added to Google Calendar so your phone alerts you.
- **Reports:** day, week, month and year views compared with the previous period, an AI-written summary, and a Markdown download.
- **AI Coach:** tell it what you did in plain words ("bench 60kg 4x8, studied math 2h") and it saves each item to the right section. Each section also has its own AI helper.
- **Phone-friendly:** a bottom tab bar, large touch targets, and it can be added to the iPhone home screen.

## How it runs

The app is a single page, `index.html`, published as a claude.ai artifact.

- **Saved data:** your log is stored privately per user through the artifact's database.
- **AI:** the AI features run on the viewer's own Claude plan, so no API key is needed.
- **Opened outside claude.ai:** the app still works but saves only in that browser, and the AI features are turned off.

`agent.py` is an earlier terminal version of the coach that uses the Anthropic API. It needs an `ANTHROPIC_API_KEY`.

## Files

| Path | What it is |
|---|---|
| `index.html` | The app |
| `exlib.json`, `ex/` | Exercise library: names, muscles, instructions, and 2 photos per exercise |
| `agent.py`, `requirements.txt` | Terminal version of the coach (Python) |

## Credits

Exercise photos and instructions come from [free-exercise-db](https://github.com/yuhonas/free-exercise-db), which is released into the public domain under the Unlicense.
