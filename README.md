# MORPHO — Telegram Mini App

A butterfly-themed tap-to-mine crypto Telegram Mini App. Each user has their own
database record storing balance, energy, referrals, tasks and wallets. Live
MORPHO price is pulled from CoinGecko.

## Features

- **Per-user database** (PostgreSQL) — every Telegram user gets their own record.
- **Welcome bonus** — new users start with **10 MORPHO**.
- **Tap to mine** — **+0.05 MORPHO** per tap.
- **Energy** — 1000 taps per cycle. When depleted it takes **5 hours** to refill
  back to 1000. The 5-hour timer starts on your **first tap** of a cycle and the
  button shows **"Ready"** when energy is full.
- **Progress bar** reflects remaining energy (energy / 1000).
- **Referrals** — share your link; you earn **10 MORPHO** per successful referral.
- **Live price** from CoinGecko.
- **ETH wallet pill** (top-right) — tapping it shows the airdrop-date notice
  (Airdrop distribution starts on **September 25, 2026**).

## Tech

- Node.js + Express backend (`server.js`)
- PostgreSQL in production; falls back to in-process **PGlite** locally (`db.js`)
- Static frontend in `public/index.html`
- Telegram `initData` is validated server-side with your bot token (HMAC-SHA256).

## Local development

```bash
npm install
ALLOW_DEV=true npm start
# open http://localhost:3000
```

With no `DATABASE_URL` set, the app uses a built-in local database (PGlite) so you
can test without installing PostgreSQL. `ALLOW_DEV=true` lets the app run in a
normal browser without Telegram (a fake dev user is used).

## Deploy to Render (free)

1. Push this repo to GitHub (already at `udehpreciousnna-afk/morphoapp`).
2. Go to <https://dashboard.render.com> → **New** → **Blueprint**.
3. Connect the GitHub repo. Render reads `render.yaml` and creates:
   - a **web service** (`morpho-app`)
   - a free **PostgreSQL database** (`morpho-db`), auto-wired via `DATABASE_URL`.
4. In the web service **Environment** settings, set:
   - `BOT_TOKEN` = your bot token from **@BotFather** (required for secure login).
   - `BOT_USERNAME` = `MorphoMiningBot` (already set).
   - `APP_SHORT_NAME` = `myapp` (already set).
   - Keep `ALLOW_DEV` = `false`.
5. Click **Apply / Deploy**. When it's live you'll get a URL like
   `https://morpho-app.onrender.com`.

### Link it to your Telegram bot

1. Open **@BotFather** → `/myapps` (or `/newapp`) → pick **MorphoMiningBot**.
2. Set the **Web App URL** to your Render URL (e.g. `https://morpho-app.onrender.com`).
3. Your Mini App opens at `https://t.me/MorphoMiningBot/myapp`.

> **Note:** Render's free PostgreSQL database expires ~90 days after creation.
> Before then, create a new free database (or upgrade) and update `DATABASE_URL`
> to keep user data. The free web service also sleeps when idle and wakes on the
> next request (first load may be slow).

## Environment variables

See `.env.example`. Summary:

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (Render sets this). |
| `DATABASE_URL` | PostgreSQL connection string (Render provides it). Empty = local PGlite. |
| `BOT_TOKEN` | Telegram bot token, for validating logins. |
| `BOT_USERNAME` | Bot username (default `MorphoMiningBot`). |
| `APP_SHORT_NAME` | Mini App short name (default `myapp`). |
| `ALLOW_DEV` | `true` only for local browser testing. |
