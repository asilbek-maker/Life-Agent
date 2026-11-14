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

## Install on your phone

- **App:** open https://asilbek-maker.github.io/Life-Agent/ in Safari (iPhone) or Chrome (Android) and add it to your home screen.
- **Smart Stack widget (iPhone):** open https://asilbek-maker.github.io/Life-Agent/widget.html and follow the steps. It uses the free Scriptable app, and the script is in `widget/LifeAgentWidget.js`.

## How it runs

The main app is the installable web app on GitHub Pages (`index.html`). It is offline-first:

- **Saved data:** everything is saved on the phone first, then synced to a private Supabase database when you're signed in. Changes made offline wait in a queue and sync later.
- **Sign-in:** a one-time code sent by email. No password.
- **Privacy:** Row Level Security is on for every table. The public key in `js/config.js` can read nothing; a signed-in user sees only their own rows.
- **Secrets:** API keys live only in Supabase secrets. See `.env.example`.

An older copy also runs as a claude.ai artifact, with its own separate data. `agent.py` is an earlier terminal version of the coach.

## Files

| Path | What it is |
|---|---|
| `index.html` | The app |
| `js/config.js`, `js/cloud.js` | Supabase settings and offline-first sync |
| `supabase/migrations/` | Database schema and security rules |
| `vendor/supabase.js` | Supabase client library (v2.45.4), kept locally so the app works offline |
| `exlib.json`, `ex/` | Exercise library: names, muscles, instructions, and 2 photos per exercise |
| `agent.py`, `requirements.txt` | Terminal version of the coach (Python) |

## Credits

Exercise photos and instructions come from [free-exercise-db](https://github.com/yuhonas/free-exercise-db), which is released into the public domain under the Unlicense.
