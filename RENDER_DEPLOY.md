# Deploying Mantle Mining App to Render

This guide deploys the app as a **Node Web Service** on Render, backed by a Render PostgreSQL database.

---

## 1. Prepare the code

1. Unzip `mantle_mining_app.zip`.
2. Push the unzipped folder to a **new, private GitHub repository** (Render deploys from Git).
   - Do **not** commit a real `.env` file. Keep secrets only in Render's dashboard.

---

## 2. Create the PostgreSQL database

1. In the Render dashboard click **New +** → **PostgreSQL**.
2. Give it a name (e.g. `mantle-db`), pick a region and the Free plan, then **Create Database**.
3. When it finishes provisioning, open it and copy the **Internal Database URL**.
   You'll paste this as `DATABASE_URL` in the next step.

---

## 3. Create the Web Service

1. Click **New +** → **Web Service** and connect your GitHub repo.
2. Configure:
   - **Environment:** `Node`
   - **Region:** same region as your database
   - **Build Command:**
     ```
     yarn install && yarn prisma generate && yarn prisma db push && yarn build
     ```
   - **Start Command:**
     ```
     yarn start
     ```
3. Under **Advanced → Environment Variables**, add every key from `.env.example`
   (see the full list below) with your real values.
4. Click **Create Web Service**. Render will build and deploy.

> `yarn prisma db push` in the build command creates the database tables on first
> deploy. After the first successful deploy you may remove it from the build
> command to speed up future builds.

---

## 4. Environment variables

| Key | What to put |
|-----|-------------|
| `DATABASE_URL` | Internal Database URL from your Render PostgreSQL |
| `NEXTAUTH_SECRET` | Random secret — run `openssl rand -base64 32` |
| `AUTH_SECRET` | Same value as `NEXTAUTH_SECRET` |
| `NEXTAUTH_URL` | Your Render service URL, e.g. `https://mantle-mining.onrender.com` |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `BOT_USERNAME` | Your bot username (no `@`) |
| `APP_SHORT_NAME` | Mini App short name registered in @BotFather |
| `TEST_ACCOUNT_EMAIL` | Any email (seed account, optional) |
| `TEST_ACCOUNT_PASSWORD` | Any password (seed account, optional) |
| `NODE_ENV` | `production` |

---

## 5. Connect the Telegram Mini App

1. In @BotFather run `/newapp`, pick your bot, and set the **Web App URL** to your
   Render URL (e.g. `https://mantle-mining.onrender.com`).
2. Open the bot in Telegram and launch the Mini App — the game loads from `/game.html`.

---

## 6. Notes

- Render's **Free** web service plan sleeps after inactivity; the first request after
  a sleep takes a few seconds to wake. Upgrade to a paid instance for always-on.
- Keep all secrets in Render's Environment tab only — never in the repo.
- To reset the database schema later, re-run `yarn prisma db push` locally against
  `DATABASE_URL` (this can drop data — back up first).
