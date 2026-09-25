# MORPHO Telegram Mini App

Existing MORPHO mini app (Node/Express + single-file frontend) with tap-to-mine, tasks, referrals, wallet save, Telegram auth, admin dashboard, and MORPHO/ETH wallet flows.

## Stack
- Backend: `server.js` (Express)
- DB: PostgreSQL in production (`DATABASE_URL`) or local PGlite fallback (`PGLITE_DIR`)
- Frontend: `public/index.html` (no framework/build step)
- Admin: `public/admin.html`

## Local run
```bash
cd /home/ubuntu/morphoapp
npm install
PGLITE_DIR=/home/ubuntu/.tmp/morpho-pglite ALLOW_DEV=true PORT=3000 npm start
```
Open `http://localhost:3000` (on the VM).

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (use 3000 in this VM) |
| `DATABASE_URL` | PostgreSQL URL (Render provides in production) |
| `BOT_TOKEN` | Telegram bot token (required in production) |
| `BOT_USERNAME` | Telegram bot username |
| `APP_SHORT_NAME` | Mini app short name |
| `ALLOW_DEV` | Enables browser fallback auth for local testing |
| `PUBLIC_URL` | Optional public base URL used to build IPN callback URL |
| `NOWPAYMENTS_API_KEY` | NOWPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | NOWPayments webhook signature secret |
| `NOWPAYMENTS_SANDBOX` | `true` for NOWPayments sandbox |
| `ETH_DEPOSIT_MIN` | Minimum ETH deposit (default `0.005`) |
| `ETH_WITHDRAW_MIN` | Minimum ETH withdrawal (default `0.005`) |
| `MORPHO_ETH_GATE` | ETH required to unlock MORPHO withdrawal (default `0.008`) |
| `ETH_NETWORK_FEE` | Displayed network fee (default `0.0005`) |
| `ETH_DEPOSIT_CONFIRMATIONS` | Confirmation requirement shown and tracked (default `12`) |
| `ETH_DEPOSIT_ETA_TEXT` | Deposit ETA text shown in UI |
| `ETH_USD` | Display-only ETH/USD estimate for UI |
| `ADMIN_KEY` | Admin dashboard key |

## Deposit processing and idempotency
- NOWPayments webhook (`/api/webhook/nowpayments`) validates signature when IPN secret exists.
- Deposit status polling endpoint (`/api/eth/deposit/status/:paymentId`) and webhook both use the same processing pipeline.
- Deposit crediting is exactly-once guarded in DB update path.
- Under-minimum deposits are marked failed with `below_minimum` and are not credited.

## Dev-only deposit simulation
To test end-to-end deposit UX without NOWPayments credentials:
- Endpoint: `POST /api/dev/eth/deposit/simulate`
- Enabled **only** when `ALLOW_DEV=true` **and** `NOWPAYMENTS_API_KEY` is empty.
- Actions: `detected`, `confirming`, `completed`, `underpaid`.
- Uses the same processing pipeline as webhook/poll logic.

Example payload:
```json
{
  "devUser": {"id": "12345", "first_name": "Dev"},
  "paymentId": "mock_xxxxx",
  "action": "completed",
  "amount": 0.01
}
```

## Notes
- Keep `ALLOW_DEV=false` in production.
- Secrets (`NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `DATABASE_URL`) are server-side only.
