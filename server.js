/**
 * MORPHO — Telegram Mini App backend
 * ------------------------------------------------------------------
 * - Serves the SPA from /public
 * - Authenticates users via Telegram WebApp initData (HMAC-SHA256)
 * - Stores each user + their activities in PostgreSQL
 * - Tap-to-mine sync, tasks, wallets, functional referrals
 * - Live MORPHO price proxied & cached from CoinGecko
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '256kb' }));

// In-memory upload handling for broadcast media (photos/videos), up to 50MB (Telegram bot limit).
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ---- Config -------------------------------------------------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'MorphoMiningBot';
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || 'myapp';
const ALLOW_DEV = process.env.ALLOW_DEV !== 'false'; // allow browser testing w/o Telegram

// ---- NowPayments (ETH deposits) ----------------------------------
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const NOWPAYMENTS_SANDBOX = process.env.NOWPAYMENTS_SANDBOX === 'true';
const NOWPAYMENTS_BASE = NOWPAYMENTS_SANDBOX
  ? 'https://api-sandbox.nowpayments.io/v1'
  : 'https://api.nowpayments.io/v1';
// Public base URL used to build the IPN callback (Render sets RENDER_EXTERNAL_URL).
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

// Deposit / withdrawal economics
const ETH_DEPOSIT_MIN = Number(process.env.ETH_DEPOSIT_MIN || 0.005);
const ETH_WITHDRAW_MIN = Number(process.env.ETH_WITHDRAW_MIN || 0.005);
const MORPHO_ETH_GATE = Number(process.env.MORPHO_ETH_GATE || 0.008);
const ETH_NETWORK_FEE = Number(process.env.ETH_NETWORK_FEE || 0.0005);
const ETH_DEPOSIT_CONFIRMATIONS = Math.max(1, Number(process.env.ETH_DEPOSIT_CONFIRMATIONS || 12));
const ETH_DEPOSIT_ETA_TEXT = process.env.ETH_DEPOSIT_ETA_TEXT || 'typically 1–2 minutes';
const ETH_USD = Number(process.env.ETH_USD || 2650); // indicative ETH→USD for display

// Game economy
const MAX_ENERGY = 1000;
const REFILL_MS = 5 * 60 * 60 * 1000; // 5 hours
const PER_TAP = 0.008;                // MORPHO per tap
const WELCOME_BONUS = 20;              // new user starts with 2 MORPHO
const REFERRAL_REWARD = 15;           // referrer earns 10 MORPHO per referral

const TASKS = {
  1: { reward: 5, eth: 0.001, chat: '@MorphoMining' },
  2: { reward: 2, eth: 0.0005, chat: '@Crypto365team' },
  3: { reward: 2, eth: 0.0005 },
  4: { reward: 1, eth: 0 }, 5: { reward: 1, eth: 0 },
};

// In-memory broadcast job tracker
const broadcastJobs = {};

// Verify a Telegram user is a member of a channel/group (requires bot to be admin).
// Returns { checked, member }. checked=false means we couldn't verify (no token / API error)
// and the caller falls back to honor-system crediting rather than locking users out.
async function isChatMember(chat, userId) {
  if (!BOT_TOKEN) return { checked: false, member: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, user_id: Number(userId) }),
    });
    const data = await r.json();
    if (!data || !data.ok) return { checked: false, member: false };
    const status = data.result && data.result.status;
    return { checked: true, member: ['creator', 'administrator', 'member', 'restricted'].includes(status) };
  } catch (e) {
    return { checked: false, member: false };
  }
}

// Daily check-in rewards (7-day cycle, MORPHO amounts per day)
const DAILY_REWARDS = [2, 5, 8, 10, 12, 15, 20];

// UTC date helpers (YYYY-MM-DD)
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function todayStr() {
  return toDateStr(new Date());
}
function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateStr(d);
}
// Normalize a DB DATE value (Date object or string) to YYYY-MM-DD, or null
function lastClaimStr(v) {
  if (!v) return null;
  if (v instanceof Date) return toDateStr(v);
  return String(v).slice(0, 10);
}
// Compute daily-reward status for a user row
function dailyStatus(row) {
  const last = lastClaimStr(row.last_claim_date);
  const streak = Number(row.daily_streak || 0);
  const today = todayStr();
  const canClaim = last !== today;
  let nextDay;
  if (!canClaim) {
    nextDay = ((streak - 1 + 7) % 7) + 1; // day already claimed today
  } else if (last === yesterdayStr() && streak > 0) {
    nextDay = (streak % 7) + 1;           // continue streak
  } else {
    nextDay = 1;                          // reset
  }
  return { dailyStreak: streak, dailyCanClaim: canClaim, dailyNextDay: nextDay };
}

// ------------------------------------------------------------------
//  Telegram initData validation
// ------------------------------------------------------------------
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return { user, start_param: params.get('start_param') || null };
  } catch (e) {
    return null;
  }
}

/**
 * Resolve the authenticated user for a request.
 * Priority: valid Telegram initData -> dev fallback (browser testing).
 * Returns { id, user, start_param, verified } or null.
 */
function resolveIdentity(req) {
  const { initData, devUser, startParam } = req.body || {};
  const v = validateInitData(initData);
  if (v) {
    return {
      id: String(v.user.id),
      user: v.user,
      start_param: v.start_param || startParam || null,
      verified: true,
    };
  }
  // Dev / browser fallback (no valid Telegram signature)
  if (ALLOW_DEV && devUser && devUser.id) {
    return {
      id: String(devUser.id),
      user: devUser,
      start_param: startParam || null,
      verified: false,
    };
  }
  return null;
}

// ------------------------------------------------------------------
//  Energy / timer computation (all-or-nothing 5h refill)
// ------------------------------------------------------------------
function computeState(row) {
  let energy = row.energy;
  let timerStart = row.timer_start != null ? Number(row.timer_start) : null;
  let changed = false;

  if (timerStart != null) {
    const elapsed = Date.now() - timerStart;
    if (elapsed >= REFILL_MS) {
      energy = MAX_ENERGY;
      timerStart = null;
      changed = true;
    }
  }
  const remaining = timerStart != null ? Math.max(0, REFILL_MS - (Date.now() - timerStart)) : 0;
  return { energy, timerStart, remaining, changed };
}

function publicUser(row, extra = {}) {
  const st = computeState(row);
  return {
    telegramId: row.telegram_id,
    username: row.username,
    firstName: row.first_name,
    balance: Number(row.morpho_balance),
    ethBalance: Number(row.eth_balance || 0),
    energy: st.energy,
    maxEnergy: MAX_ENERGY,
    timerRemaining: st.remaining,          // ms until refill (0 = Ready)
    ready: st.timerStart == null,
    referralCount: row.referral_count,
    referredBy: row.referred_by,
    completedTasks: row.completed_tasks || [],
    wallets: row.wallets || {},
    totalTaps: Number(row.total_taps),
    createdAt: row.created_at,
    lastActive: row.last_active,
    perTap: PER_TAP,
    refillMs: REFILL_MS,
    dailyRewards: DAILY_REWARDS,
    ...dailyStatus(row),
    ...extra,
  };
}

async function logActivity(id, type, detail = {}) {
  try {
    await db.query(
      'INSERT INTO activities (telegram_id, type, detail) VALUES ($1,$2,$3)',
      [id, type, JSON.stringify(detail)]
    );
  } catch (e) { /* non-fatal */ }
}

async function getUser(id) {
  const r = await db.query('SELECT * FROM users WHERE telegram_id=$1', [id]);
  return r.rows[0] || null;
}

// ------------------------------------------------------------------
//  CoinGecko price proxy (cached 60s)
// ------------------------------------------------------------------
let priceCache = { usd: 1.18, ts: 0 };
async function getPrice() {
  if (Date.now() - priceCache.ts < 60_000 && priceCache.ts !== 0) return priceCache.usd;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=morpho&vs_currencies=usd', {
      headers: { 'accept': 'application/json' },
    });
    const j = await res.json();
    const usd = j && j.morpho && typeof j.morpho.usd === 'number' ? j.morpho.usd : priceCache.usd;
    priceCache = { usd, ts: Date.now() };
  } catch (e) {
    priceCache.ts = Date.now(); // avoid hammering on failure
  }
  return priceCache.usd;
}

// ==================================================================
//  NowPayments helpers (ETH deposits)
// ==================================================================
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { /* optional */ }

// Build a QR-code data URI for a payment address (falls back to null).
async function makeQr(text) {
  if (!QRCode || !text) return null;
  try {
    return await QRCode.toDataURL(String(text), {
      width: 320, margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (e) { return null; }
}

// Create a deposit payment via the NowPayments API.
// Returns { paymentId, address, payAmount, payCurrency } or throws.
// When no API key is configured we fall back to a deterministic MOCK address so
// the whole deposit UX remains testable without live credentials.
async function createDepositAddress(amount, currency) {
  const cur = String(currency || 'eth').toLowerCase();
  if (!NOWPAYMENTS_API_KEY) {
    // ---- MOCK MODE ----
    const rand = crypto.randomBytes(20).toString('hex');
    return {
      paymentId: 'mock_' + crypto.randomBytes(8).toString('hex'),
      address: '0x' + rand,
      payAmount: Number(amount),
      payCurrency: cur,
      mock: true,
    };
  }
  const body = {
    price_amount: Number(amount),
    price_currency: cur,
    pay_currency: cur,
    order_id: 'morpho_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    order_description: 'MORPHO ETH deposit',
  };
  if (PUBLIC_URL) body.ipn_callback_url = PUBLIC_URL.replace(/\/$/, '') + '/api/webhook/nowpayments';

  const r = await fetch(`${NOWPAYMENTS_BASE}/payment`, {
    method: 'POST',
    headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j || !j.payment_id) {
    throw new Error((j && (j.message || j.error)) || `NowPayments HTTP ${r.status}`);
  }
  return {
    paymentId: String(j.payment_id),
    address: j.pay_address,
    payAmount: Number(j.pay_amount || amount),
    payCurrency: (j.pay_currency || cur),
    mock: false,
  };
}

// Poll NowPayments for a payment's current status. Returns the raw status string.
async function checkPaymentStatus(paymentId) {
  if (!NOWPAYMENTS_API_KEY || String(paymentId).startsWith('mock_')) {
    return { payment_status: 'waiting', mock: true };
  }
  const r = await fetch(`${NOWPAYMENTS_BASE}/payment/${encodeURIComponent(paymentId)}`, {
    headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && (j.message || j.error)) || `NowPayments HTTP ${r.status}`);
  return j;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function normalizeStatusForClient(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'pending' || s === 'awaiting') return 'awaiting';
  return s;
}

// Map a NowPayments payment_status to our internal transaction status.
function mapPaymentStatus(s) {
  const raw = String(s || '').toLowerCase();
  switch (raw) {
    case 'waiting':
    case 'new':
      return { status: 'awaiting', failureReason: null };
    case 'partially_paid':
      return { status: 'detected', failureReason: null };
    case 'confirming':
    case 'sending':
      return { status: 'confirming', failureReason: null };
    case 'finished':
    case 'confirmed':
      return { status: 'completed', failureReason: null };
    case 'failed':
    case 'refunded':
    case 'expired':
      return { status: 'failed', failureReason: raw };
    default:
      return { status: 'awaiting', failureReason: null };
  }
}

function parseNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanIdempotencyKey(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return s.slice(0, 120);
}

async function getExistingIdempotentTxn(userId, idempotencyKey, type) {
  if (!idempotencyKey) return null;
  const q = await db.query(
    `SELECT * FROM transactions WHERE telegram_id=$1 AND idempotency_key=$2 AND type=$3 ORDER BY id DESC LIMIT 1`,
    [userId, idempotencyKey, type]
  );
  return q.rows[0] || null;
}

async function applyDepositPipeline({ paymentId, paymentStatus, confirmations, receivedAmount, txnHash, source = 'poll' }) {
  const txQ = await db.query('SELECT * FROM transactions WHERE payment_id=$1', [paymentId]);
  const txn = txQ.rows[0];
  if (!txn) return { ok: false, error: 'not_found' };
  if (txn.type !== 'eth_deposit') return { ok: false, error: 'not_eth_deposit' };

  const mapped = mapPaymentStatus(paymentStatus);
  const conf = Math.max(0, parseInt(confirmations || 0, 10) || 0);
  const paid = parseNum(receivedAmount, parseNum(txn.received_amount, null));
  const hash = txnHash || txn.txn_hash || null;

  if (mapped.status === 'completed') {
    if (!Number.isFinite(paid) || paid < ETH_DEPOSIT_MIN) {
      const fail = await db.query(
        `UPDATE transactions
            SET status='failed',
                failure_reason='below_minimum',
                confirmations=GREATEST(COALESCE(confirmations,0), $2),
                txn_hash=COALESCE($3, txn_hash),
                received_amount=COALESCE($4, received_amount),
                completed_at=now()
          WHERE payment_id=$1 AND COALESCE(LOWER(BTRIM(status)),'') <> 'completed'
          RETURNING *`,
        [paymentId, conf, hash, paid]
      );
      return { ok: true, transaction: fail.rows[0] || txn, credited: false };
    }

    const credit = await db.query(
      `WITH updated AS (
         UPDATE transactions
            SET status='completed',
                failure_reason=NULL,
                confirmations=GREATEST(COALESCE(confirmations,0), $2),
                txn_hash=COALESCE($3, txn_hash),
                received_amount=COALESCE($4, received_amount),
                confirmed_at=COALESCE(confirmed_at, now()),
                completed_at=COALESCE(completed_at, now())
          WHERE payment_id=$1 AND COALESCE(LOWER(BTRIM(status)),'') <> 'completed'
          RETURNING *
       ),
       credited AS (
         UPDATE users u
            SET eth_balance = u.eth_balance + COALESCE(updated.received_amount, updated.amount),
                last_active = now()
           FROM updated
          WHERE u.telegram_id = updated.telegram_id
          RETURNING updated.*
       )
       SELECT * FROM credited`,
      [paymentId, conf, hash, paid]
    );

    if (credit.rows[0]) {
      await logActivity(credit.rows[0].telegram_id, 'eth_deposit_credited', {
        txnId: credit.rows[0].id,
        amount: Number(credit.rows[0].received_amount || credit.rows[0].amount),
        paymentId,
        source,
      });
      return { ok: true, transaction: credit.rows[0], credited: true };
    }

    const unchanged = await db.query('SELECT * FROM transactions WHERE payment_id=$1', [paymentId]);
    return { ok: true, transaction: unchanged.rows[0] || txn, credited: false };
  }

  const upd = await db.query(
    `UPDATE transactions
        SET status=$2,
            failure_reason=COALESCE($3, failure_reason),
            confirmations=GREATEST(COALESCE(confirmations,0), $4),
            txn_hash=COALESCE($5, txn_hash),
            received_amount=COALESCE($6, received_amount),
            completed_at = CASE WHEN $2='failed' THEN COALESCE(completed_at, now()) ELSE completed_at END
      WHERE payment_id=$1 AND COALESCE(LOWER(BTRIM(status)),'') NOT IN ('completed','failed')
      RETURNING *`,
    [paymentId, mapped.status, mapped.failureReason, conf, hash, paid]
  );
  return { ok: true, transaction: upd.rows[0] || txn, credited: false };
}

// Deterministically stringify+HMAC an object the way NowPayments signs IPNs.
function npIpnSignature(payload) {
  const sortedStringify = (obj) => {
    if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
    if (obj && typeof obj === 'object') {
      return '{' + Object.keys(obj).sort().map(
        (k) => JSON.stringify(k) + ':' + sortedStringify(obj[k])
      ).join(',') + '}';
    }
    return JSON.stringify(obj);
  };
  return crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
    .update(sortedStringify(payload)).digest('hex');
}

// ==================================================================
//  API ROUTES
// ==================================================================

// --- Init / login: create or fetch user, handle referral ----------
app.post('/api/init', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  let row = await getUser(idn.id);

  if (!row) {
    // Resolve referrer from start_param (format: REF_<id> or plain <id>)
    let referredBy = null;
    let raw = idn.start_param || '';
    if (raw.startsWith('REF_')) raw = raw.slice(4);
    if (raw && raw !== idn.id) {
      const ref = await getUser(raw);
      if (ref) referredBy = raw;
    }

    const ins = await db.query(
      `INSERT INTO users (telegram_id, username, first_name, photo_url, morpho_balance, energy, referred_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        idn.id,
        idn.user.username || null,
        idn.user.first_name || 'Miner',
        idn.user.photo_url || null,
        WELCOME_BONUS,
        MAX_ENERGY,
        referredBy,
      ]
    );
    row = ins.rows[0];
    await logActivity(idn.id, 'signup', { welcome: WELCOME_BONUS, referredBy });

    // Credit the referrer
    if (referredBy) {
      await db.query(
        `UPDATE users SET referral_count = referral_count + 1,
                          morpho_balance = morpho_balance + $2
         WHERE telegram_id = $1`,
        [referredBy, REFERRAL_REWARD]
      );
      await logActivity(referredBy, 'referral', { newUser: idn.id, reward: REFERRAL_REWARD });
    }
  } else {
    // Refresh profile + recompute energy timer
    const st = computeState(row);
    await db.query(
      `UPDATE users SET username=$2, first_name=$3, energy=$4, timer_start=$5, last_active=now()
       WHERE telegram_id=$1`,
      [idn.id, idn.user.username || row.username, idn.user.first_name || row.first_name,
       st.energy, st.timerStart]
    );
    row.energy = st.energy;
    row.timer_start = st.timerStart;
    if (idn.user.username) row.username = idn.user.username;
    if (idn.user.first_name) row.first_name = idn.user.first_name;
  }

  const price = await getPrice();
  const refLink = `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=REF_${idn.id}`;
  res.json({ user: publicUser(row, { verified: idn.verified }), price, refLink });
});

// --- Tap batch: apply taps, start/refresh 5h timer ----------------
app.post('/api/tap', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  let taps = parseInt(req.body.taps, 10);
  if (!Number.isFinite(taps) || taps <= 0) taps = 0;
  taps = Math.min(taps, MAX_ENERGY); // safety clamp per request

  let row = await getUser(idn.id);
  if (!row) return res.status(404).json({ error: 'no_user' });

  const st = computeState(row);
  let energy = st.energy;
  let timerStart = st.timerStart;

  const allowed = Math.min(taps, energy);
  if (allowed > 0) {
    // Timer starts on the first tap of a fresh (Ready) cycle
    if (timerStart == null) timerStart = Date.now();
    energy -= allowed;
    const gained = allowed * PER_TAP;
    const upd = await db.query(
      `UPDATE users SET morpho_balance = morpho_balance + $2,
                        energy = $3, timer_start = $4,
                        total_taps = total_taps + $5, last_active = now()
       WHERE telegram_id = $1 RETURNING *`,
      [idn.id, gained, energy, timerStart, allowed]
    );
    row = upd.rows[0];
  } else {
    // Persist any timer refill that happened during compute
    if (st.changed) {
      await db.query('UPDATE users SET energy=$2, timer_start=$3 WHERE telegram_id=$1',
        [idn.id, energy, timerStart]);
      row.energy = energy; row.timer_start = timerStart;
    }
  }

  res.json({ user: publicUser(row) });
});

// --- Complete a task ----------------------------------------------
app.post('/api/task', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });
  const taskId = parseInt(req.body.taskId, 10);
  const task = TASKS[taskId];
  if (!task) return res.status(400).json({ error: 'bad_task' });

  let row = await getUser(idn.id);
  if (!row) return res.status(404).json({ error: 'no_user' });

  const done = Array.isArray(row.completed_tasks) ? row.completed_tasks : [];
  if (done.includes(taskId)) {
    return res.json({ user: publicUser(row), already: true });
  }

  // Enforce real membership for verifiable Telegram tasks (bot must be channel admin).
  // Only block on a definitive "not a member" answer; if we can't verify, fall back to crediting.
  if (task.chat && idn.verified) {
    const chk = await isChatMember(task.chat, idn.id);
    if (chk.checked && !chk.member) {
      return res.status(403).json({ error: 'not_member' });
    }
  }

  done.push(taskId);
  const upd = await db.query(
    `UPDATE users SET completed_tasks=$2, morpho_balance = morpho_balance + $3,
                      eth_balance = eth_balance + $4, last_active=now()
     WHERE telegram_id=$1 RETURNING *`,
    [idn.id, JSON.stringify(done), task.reward, task.eth]
  );
  await logActivity(idn.id, 'task', { taskId, reward: task.reward, eth: task.eth });
  res.json({ user: publicUser(upd.rows[0]), reward: task.reward, ethReward: task.eth });
});

// --- Daily reward claim -------------------------------------------
app.post('/api/daily/claim', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  let row = await getUser(idn.id);
  if (!row) return res.status(404).json({ error: 'no_user' });

  const st = dailyStatus(row);
  if (!st.dailyCanClaim) {
    return res.json({ user: publicUser(row), already: true });
  }
  const day = st.dailyNextDay;                 // 1..7
  const reward = DAILY_REWARDS[day - 1] || 0;
  const upd = await db.query(
    `UPDATE users SET morpho_balance = morpho_balance + $2,
                      daily_streak = $3, last_claim_date = $4, last_active = now()
     WHERE telegram_id = $1 RETURNING *`,
    [idn.id, reward, day, todayStr()]
  );
  await logActivity(idn.id, 'daily', { day, reward });
  res.json({ user: publicUser(upd.rows[0]), claimedDay: day, reward });
});

// --- Save / update a wallet address -------------------------------
app.post('/api/wallet', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });
  const key = String(req.body.wallet || '').toLowerCase();
  const address = String(req.body.address || '').trim();
  const valid = ['trustwallet', 'binance', 'bitget', 'phantom', 'bybit'];
  if (!valid.includes(key) || !address) return res.status(400).json({ error: 'bad_wallet' });

  let row = await getUser(idn.id);
  if (!row) return res.status(404).json({ error: 'no_user' });
  const wallets = (row.wallets && typeof row.wallets === 'object') ? row.wallets : {};
  wallets[key] = address;
  const upd = await db.query(
    'UPDATE users SET wallets=$2, last_active=now() WHERE telegram_id=$1 RETURNING *',
    [idn.id, JSON.stringify(wallets)]
  );
  await logActivity(idn.id, 'wallet', { wallet: key });
  res.json({ user: publicUser(upd.rows[0]) });
});

// --- Live price ----------------------------------------------------
app.get('/api/price', async (_req, res) => {
  const usd = await getPrice();
  res.json({ usd });
});

// --- Health --------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- Admin: list users ---------------------------------------------
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.get('/api/admin/users', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  // Whitelist sortable columns (never interpolate raw user input into SQL).
  const SORT_COLS = {
    balance: 'morpho_balance',
    referrals: 'referral_count',
    taps: 'total_taps',
    joined: 'created_at',
    active: 'last_active',
  };
  const sortCol = SORT_COLS[req.query.sort] || 'last_active';
  const dir = (req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // Optional search over username / first name / telegram id.
  const search = (req.query.search || '').toString().trim();
  const params = [];
  let where = '';
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    where = `WHERE (LOWER(COALESCE(username,'')) LIKE $1
                 OR LOWER(COALESCE(first_name,'')) LIKE $1
                 OR LOWER(telegram_id) LIKE $1)`;
  }

  try {
    const listParams = params.slice();
    listParams.push(limit, offset);
    const { rows } = await db.query(
      `SELECT * FROM users ${where}
       ORDER BY ${sortCol} ${dir} NULLS LAST, telegram_id ASC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM users ${where}`,
      params
    );

    res.json({
      total: countRes.rows[0].total,
      count: rows.length,
      users: rows.map((r) => publicUser(r)),
    });
  } catch (e) {
    console.error('[admin/users] error:', e);
    res.status(500).json({ error: 'query_failed' });
  }
});

// --- Admin: single user detail (incl. activity log) ----------------
app.get('/api/admin/users/:id', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const row = await getUser(req.params.id);
  if (!row) return res.status(404).json({ error: 'no_user' });

  const { rows: activity } = await db.query(
    'SELECT * FROM activities WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 200',
    [req.params.id]
  );

  res.json({ user: publicUser(row), raw: row, activity });
});

// --- Admin: Telegram broadcast to all users ------------------------
// POST /api/admin/broadcast  (multipart/form-data OR json)
//   fields: key, message, target, buttonText, buttonUrl
//   file  : media  (optional image/* or video/*)
const BROADCAST_CHANNELS = ['@MorphoMining', '@Crypto365team'];
app.post('/api/admin/broadcast', uploadMedia.single('media'), async (req, res) => {
  const key = req.body.key || req.query.key || req.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  if (!BOT_TOKEN) return res.status(400).json({ error: 'BOT_TOKEN not configured' });

  const message = (req.body.message || '').toString();
  const media = req.file || null;
  let mediaKind = null;
  if (media) {
    if (/^image\//i.test(media.mimetype)) mediaKind = 'photo';
    else if (/^video\//i.test(media.mimetype)) mediaKind = 'video';
    else return res.status(400).json({ error: 'Unsupported media type — attach an image or a video.' });
  }
  if (!message.trim() && !media) {
    return res.status(400).json({ error: 'Add a message or attach a photo/video.' });
  }

  const target = (req.body.target || 'all').toString();
  if (target !== 'all' && !BROADCAST_CHANNELS.includes(target)) {
    return res.status(400).json({ error: 'invalid target' });
  }

  const buttonText = (req.body.buttonText || '').toString().trim();
  const buttonUrl = (req.body.buttonUrl || '').toString().trim();
  let reply_markup;
  if (buttonText && buttonUrl) {
    if (!/^https?:\/\//i.test(buttonUrl) && !/^tg:\/\//i.test(buttonUrl)) {
      return res.status(400).json({ error: 'button URL must start with http(s):// or tg://' });
    }
    reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
  }

  async function sendTo(chatId) {
    let url, body, headers;
    if (media) {
      const method = mediaKind === 'video' ? 'sendVideo' : 'sendPhoto';
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(mediaKind, new Blob([media.buffer], { type: media.mimetype }),
        media.originalname || (mediaKind === 'video' ? 'video.mp4' : 'photo.jpg'));
      if (message.trim()) { form.append('caption', message); form.append('parse_mode', 'HTML'); }
      if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
      url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
      body = form;
    } else {
      const payload = { chat_id: chatId, text: message, parse_mode: 'HTML' };
      if (reply_markup) payload.reply_markup = reply_markup;
      url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }
    try {
      const r = await fetch(url, { method: 'POST', headers, body });
      let j = null;
      try { j = await r.json(); } catch {}
      if (r.ok && j && j.ok) return { ok: true };
      return { ok: false, description: (j && j.description) || `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, description: String(e && e.message || e) };
    }
  }

  // Single channel post: keep synchronous
  if (target !== 'all') {
    const r = await sendTo(target);
    if (r.ok) return res.json({ channel: target, ok: true });
    return res.status(400).json({ error: `Could not post to ${target}: ${r.description}` });
  }

  // Mass broadcast: start background job, respond immediately
  const jobId = crypto.randomUUID();
  broadcastJobs[jobId] = { 
    status: 'running', 
    total: 0, 
    sent: 0, 
    blocked: 0, 
    failed: 0, 
    reasons: {}, 
    startedAt: Date.now() 
  };

  res.json({ jobId, started: true });

  // Background execution (fire-and-forget)
  (async () => {
    const job = broadcastJobs[jobId];
    try {
      const { rows } = await db.query('SELECT telegram_id FROM users');
      job.total = rows.length;
      const CONCURRENCY = 20;
      let idx = 0;
      async function worker() {
        while (idx < rows.length) {
          const i = idx++;
          const { telegram_id } = rows[i];
          const r = await sendTo(telegram_id);
          if (r.ok) job.sent++;
          else {
            const d = r.description || 'unknown error';
            if (/blocked|deactivated|can't initiate|not found|chat not found/i.test(d)) job.blocked++;
            else job.failed++;
            job.reasons[d] = (job.reasons[d] || 0) + 1;
          }
          await new Promise(f => setTimeout(f, media ? 60 : 25));
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = String(e);
    }
  })();
});

// Poll broadcast progress
app.get('/api/admin/broadcast/status/:jobId', (req, res) => {
  const key = req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  const job = broadcastJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json(job);
});

// ==================================================================
//  ETH deposit / withdrawal + MORPHO withdrawal + transactions
// ==================================================================

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }

// Serialize a transaction row for the client.
function publicTxn(r) {
  return {
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    status: normalizeStatusForClient(r.status),
    paymentId: r.payment_id,
    address: r.payment_address,
    txnHash: r.txn_hash,
    network: r.network || null,
    provider: r.provider || null,
    fee: r.fee != null ? Number(r.fee) : null,
    confirmations: Number(r.confirmations || 0),
    failureReason: r.failure_reason || null,
    idempotencyKey: r.idempotency_key || null,
    confirmedAt: r.confirmed_at || null,
    receivedAmount: r.received_amount != null ? Number(r.received_amount) : null,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

// --- ETH deposit: create a NowPayments deposit address --------------
app.post('/api/eth/deposit', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  let amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) amount = ETH_DEPOSIT_MIN;
  if (amount < ETH_DEPOSIT_MIN) {
    return res.status(400).json({ error: 'min_amount', min: ETH_DEPOSIT_MIN });
  }

  try {
    const existing = await db.query(
      `SELECT * FROM transactions
        WHERE telegram_id=$1
          AND type='eth_deposit'
          AND COALESCE(LOWER(BTRIM(status)),'') IN ('awaiting','detected','confirming')
        ORDER BY created_at DESC LIMIT 1`,
      [idn.id]
    );

    if (existing.rows[0]) {
      const row = existing.rows[0];
      const qrCode = await makeQr(row.payment_address);
      return res.json({
        paymentId: row.payment_id,
        address: row.payment_address,
        min: ETH_DEPOSIT_MIN,
        confirmations: ETH_DEPOSIT_CONFIRMATIONS,
        etaText: ETH_DEPOSIT_ETA_TEXT,
        qrCode,
        transaction: publicTxn(row),
      });
    }

    const pay = await createDepositAddress(amount, 'eth');
    const ins = await db.query(
      `INSERT INTO transactions
        (telegram_id, type, amount, currency, status, payment_id, payment_address, provider, network, confirmations, received_amount)
       VALUES ($1,'eth_deposit',$2,'ETH','awaiting',$3,$4,$5,'Ethereum',0,NULL)
       RETURNING *`,
      [idn.id, amount, pay.paymentId, pay.address, pay.mock ? 'mock_nowpayments' : 'nowpayments']
    );
    await logActivity(idn.id, 'eth_deposit_created', { amount, paymentId: pay.paymentId, mock: !!pay.mock });
    const qrCode = await makeQr(pay.address);
    res.json({
      paymentId: pay.paymentId,
      address: pay.address,
      min: ETH_DEPOSIT_MIN,
      confirmations: ETH_DEPOSIT_CONFIRMATIONS,
      etaText: ETH_DEPOSIT_ETA_TEXT,
      qrCode,
      transaction: publicTxn(ins.rows[0]),
    });
  } catch (e) {
    console.error('[eth/deposit] error:', e);
    res.status(502).json({ error: 'deposit_failed' });
  }
});

// --- ETH deposit: poll status --------------------------------------
app.get('/api/eth/deposit/status/:paymentId', async (req, res) => {
  const paymentId = req.params.paymentId;
  const idn = resolveIdentity({ body: {
    initData: req.query.initData,
    devUser: req.query.devUser ? safeJson(req.query.devUser) : undefined,
  }});
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  const rowQ = await db.query('SELECT * FROM transactions WHERE payment_id=$1', [paymentId]);
  const txn = rowQ.rows[0];
  if (!txn || txn.telegram_id !== idn.id) return res.status(404).json({ error: 'not_found' });

  let finalTxn = txn;
  try {
    const info = await checkPaymentStatus(paymentId);
    const processed = await applyDepositPipeline({
      paymentId,
      paymentStatus: info.payment_status,
      confirmations: info.payin_confirmations || info.confirmations || 0,
      receivedAmount: parseNum(info.actually_paid || info.pay_amount || info.payin_amount, null),
      txnHash: info.payin_hash || info.outcome_hash || null,
      source: 'poll',
    });
    if (processed && processed.transaction) finalTxn = processed.transaction;
  } catch (e) {
    // keep last known DB state on provider poll failure
  }

  return res.json({
    status: normalizeStatusForClient(finalTxn.status),
    confirmations: Number(finalTxn.confirmations || 0),
    creditedAmount: finalTxn.received_amount != null ? Number(finalTxn.received_amount) : null,
    transaction: publicTxn(finalTxn),
  });
});

// --- NowPayments IPN webhook ---------------------------------------
app.post('/api/webhook/nowpayments', async (req, res) => {
  const payload = req.body || {};
  if (NOWPAYMENTS_IPN_SECRET) {
    const sig = req.get('x-nowpayments-sig') || '';
    let expected = '';
    try { expected = npIpnSignature(payload); } catch (e) {}
    if (!sig || sig !== expected) {
      console.warn('[webhook] invalid IPN signature');
      return res.status(401).json({ error: 'bad_signature' });
    }
  }

  const paymentId = payload.payment_id != null ? String(payload.payment_id) : null;
  if (!paymentId) return res.status(400).json({ error: 'no_payment_id' });

  try {
    const processed = await applyDepositPipeline({
      paymentId,
      paymentStatus: payload.payment_status,
      confirmations: payload.payin_confirmations || payload.confirmations || 0,
      receivedAmount: parseNum(payload.actually_paid || payload.pay_amount || payload.payin_amount, null),
      txnHash: payload.payin_hash || payload.outcome_hash || null,
      source: 'webhook',
    });
    if (!processed.ok && processed.error === 'not_found') return res.status(200).json({ ok: true, note: 'unknown payment' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e);
    return res.status(500).json({ error: 'processing_failed' });
  }
});

// --- Dev-only deposit simulation endpoint --------------------------
app.post('/api/dev/eth/deposit/simulate', async (req, res) => {
  if (!(ALLOW_DEV && !NOWPAYMENTS_API_KEY)) return res.status(404).json({ error: 'not_found' });
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  const paymentId = String(req.body.paymentId || '').trim();
  const action = String(req.body.action || '').trim(); // detected|confirming|completed|underpaid
  const amount = Number(req.body.amount || ETH_DEPOSIT_MIN);
  if (!paymentId || !action) return res.status(400).json({ error: 'bad_request' });

  const actionMap = {
    detected: { payment_status: 'partially_paid', confirmations: 1, paid: amount },
    confirming: { payment_status: 'confirming', confirmations: Math.max(1, Math.floor(ETH_DEPOSIT_CONFIRMATIONS / 2)), paid: amount },
    completed: { payment_status: 'finished', confirmations: ETH_DEPOSIT_CONFIRMATIONS, paid: amount },
    underpaid: { payment_status: 'finished', confirmations: ETH_DEPOSIT_CONFIRMATIONS, paid: Math.max(0, ETH_DEPOSIT_MIN - 0.001) },
  };
  const sim = actionMap[action];
  if (!sim) return res.status(400).json({ error: 'bad_action' });

  const txnQ = await db.query('SELECT * FROM transactions WHERE payment_id=$1 AND telegram_id=$2', [paymentId, idn.id]);
  const txn = txnQ.rows[0];
  if (!txn) return res.status(404).json({ error: 'not_found' });

  const processed = await applyDepositPipeline({
    paymentId,
    paymentStatus: sim.payment_status,
    confirmations: sim.confirmations,
    receivedAmount: sim.paid,
    txnHash: action === 'completed' ? ('0xmock' + crypto.randomBytes(8).toString('hex')) : null,
    source: 'dev_sim',
  });
  res.json({ ok: true, action, transaction: publicTxn(processed.transaction) });
});

// --- ETH withdrawal request ----------------------------------------
app.post('/api/eth/withdraw', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  const amount = Number(req.body.amount);
  const address = String(req.body.address || '').trim();
  const idempotencyKey = cleanIdempotencyKey(req.body.idempotencyKey);

  if (!EVM_ADDRESS_RE.test(address)) return res.status(400).json({ error: 'invalid_address' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'bad_amount' });
  if (amount < ETH_WITHDRAW_MIN) return res.status(400).json({ error: 'min_amount', min: ETH_WITHDRAW_MIN });

  const existing = await getExistingIdempotentTxn(idn.id, idempotencyKey, 'eth_withdrawal');
  if (existing) {
    const user = await getUser(idn.id);
    return res.json({ ok: true, idempotent: true, transaction: publicTxn(existing), balances: { morpho: Number(user?.morpho_balance || 0), eth: Number(user?.eth_balance || 0) } });
  }

  try {
    const q = await db.query(
      `WITH deducted AS (
         UPDATE users
            SET eth_balance = eth_balance - $2,
                last_active = now()
          WHERE telegram_id = $1
            AND eth_balance >= $2
         RETURNING telegram_id, eth_balance
       ), inserted AS (
         INSERT INTO transactions
           (telegram_id, type, amount, currency, status, payment_address, network, fee, idempotency_key)
         SELECT telegram_id, 'eth_withdrawal', $2, 'ETH', 'processing', $3, 'Ethereum', $4, $5
           FROM deducted
         RETURNING *
       )
       SELECT * FROM inserted`,
      [idn.id, amount, address, ETH_NETWORK_FEE, idempotencyKey]
    );

    if (!q.rows[0]) {
      const user = await getUser(idn.id);
      return res.status(400).json({ error: 'insufficient_eth_balance', ethBalance: Number(user?.eth_balance || 0) });
    }

    await logActivity(idn.id, 'eth_withdrawal_requested', { amount, address, idempotencyKey });
    const user = await getUser(idn.id);
    return res.json({ ok: true, transaction: publicTxn(q.rows[0]), balances: { morpho: Number(user?.morpho_balance || 0), eth: Number(user?.eth_balance || 0) } });
  } catch (e) {
    if (String(e.message || '').includes('idx_transactions_user_idempotency')) {
      const dupe = await getExistingIdempotentTxn(idn.id, idempotencyKey, 'eth_withdrawal');
      if (dupe) return res.json({ ok: true, idempotent: true, transaction: publicTxn(dupe) });
    }
    console.error('[eth/withdraw] error:', e);
    return res.status(500).json({ error: 'withdraw_failed' });
  }
});

// --- MORPHO withdrawal request -------------------------------------
app.post('/api/morpho/withdraw', async (req, res) => {
  const idn = resolveIdentity(req);
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  const amount = Number(req.body.amount);
  const address = String(req.body.address || '').trim();
  const idempotencyKey = cleanIdempotencyKey(req.body.idempotencyKey);

  if (!EVM_ADDRESS_RE.test(address)) return res.status(400).json({ error: 'invalid_address' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'bad_amount' });

  const existing = await getExistingIdempotentTxn(idn.id, idempotencyKey, 'morpho_withdrawal');
  if (existing) {
    const user = await getUser(idn.id);
    return res.json({ ok: true, idempotent: true, transaction: publicTxn(existing), balances: { morpho: Number(user?.morpho_balance || 0), eth: Number(user?.eth_balance || 0) } });
  }

  const u = await getUser(idn.id);
  if (!u) return res.status(404).json({ error: 'no_user' });
  if (Number(u.eth_balance || 0) < MORPHO_ETH_GATE) {
    return res.status(400).json({ error: 'insufficient_eth', needed: MORPHO_ETH_GATE, ethBalance: Number(u.eth_balance || 0) });
  }
  if (Number(u.morpho_balance || 0) < amount) {
    return res.status(400).json({ error: 'insufficient_morpho_balance', morphoBalance: Number(u.morpho_balance || 0) });
  }

  try {
    const q = await db.query(
      `WITH deducted AS (
         UPDATE users
            SET morpho_balance = morpho_balance - $2,
                last_active = now()
          WHERE telegram_id = $1
            AND morpho_balance >= $2
         RETURNING telegram_id, morpho_balance, eth_balance
       ), inserted AS (
         INSERT INTO transactions
           (telegram_id, type, amount, currency, status, payment_address, network, fee, idempotency_key)
         SELECT telegram_id, 'morpho_withdrawal', $2, 'MORPHO', 'processing', $3, 'Ethereum', $4, $5
           FROM deducted
         RETURNING *
       )
       SELECT * FROM inserted`,
      [idn.id, amount, address, ETH_NETWORK_FEE, idempotencyKey]
    );

    if (!q.rows[0]) {
      const user = await getUser(idn.id);
      return res.status(400).json({ error: 'insufficient_morpho_balance', morphoBalance: Number(user?.morpho_balance || 0) });
    }

    await logActivity(idn.id, 'morpho_withdrawal_requested', { amount, address, idempotencyKey });
    const user = await getUser(idn.id);
    return res.json({ ok: true, transaction: publicTxn(q.rows[0]), balances: { morpho: Number(user?.morpho_balance || 0), eth: Number(user?.eth_balance || 0) } });
  } catch (e) {
    if (String(e.message || '').includes('idx_transactions_user_idempotency')) {
      const dupe = await getExistingIdempotentTxn(idn.id, idempotencyKey, 'morpho_withdrawal');
      if (dupe) return res.json({ ok: true, idempotent: true, transaction: publicTxn(dupe) });
    }
    console.error('[morpho/withdraw] error:', e);
    return res.status(500).json({ error: 'withdraw_failed' });
  }
});

// --- User transaction history --------------------------------------
app.get('/api/transactions', async (req, res) => {
  const idn = resolveIdentity({ body: {
    initData: req.query.initData,
    devUser: req.query.devUser ? safeJson(req.query.devUser) : undefined,
  }});
  if (!idn) return res.status(401).json({ error: 'unauthorized' });

  const { rows } = await db.query(
    'SELECT * FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 150',
    [idn.id]
  );
  res.json({ transactions: rows.map(publicTxn) });
});

// --- Admin: deposits list ------------------------------------------
app.get('/api/admin/deposits', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.username, u.first_name
         FROM transactions t LEFT JOIN users u ON u.telegram_id=t.telegram_id
        WHERE t.type='eth_deposit'
        ORDER BY t.created_at DESC LIMIT 500`
    );
    res.json({
      deposits: rows.map((r) => ({
        ...publicTxn(r),
        telegramId: r.telegram_id,
        username: r.username,
        firstName: r.first_name,
      })),
    });
  } catch (e) {
    console.error('[admin/deposits] error:', e);
    res.status(500).json({ error: 'query_failed' });
  }
});

// --- Admin: withdrawals list ---------------------------------------
app.get('/api/admin/withdrawals', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const status = (req.query.status || '').toString();
  const params = [];
  let where = `WHERE type IN ('eth_withdrawal','morpho_withdrawal')`;
  if (status) {
    params.push(status);
    where += ` AND status=$1`;
  }
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.username, u.first_name
         FROM transactions t LEFT JOIN users u ON u.telegram_id = t.telegram_id
         ${where} ORDER BY t.created_at DESC LIMIT 500`,
      params
    );
    res.json({
      withdrawals: rows.map((r) => ({
        ...publicTxn(r),
        telegramId: r.telegram_id,
        username: r.username,
        firstName: r.first_name,
      })),
    });
  } catch (e) {
    console.error('[admin/withdrawals] error:', e);
    res.status(500).json({ error: 'query_failed' });
  }
});

// --- Admin: approve (complete) a withdrawal ------------------------
app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
  const key = req.body.key || req.query.key || req.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  const id = parseInt(req.params.id, 10);
  const txnHash = req.body && req.body.txnHash ? String(req.body.txnHash).trim() : null;

  const upd = await db.query(
    `UPDATE transactions
        SET status='completed',
            txn_hash=COALESCE($2, txn_hash),
            completed_at=COALESCE(completed_at, now()),
            confirmed_at=COALESCE(confirmed_at, now())
      WHERE id=$1
        AND type IN ('eth_withdrawal','morpho_withdrawal')
        AND status IN ('processing','pending','confirming')
      RETURNING *`,
    [id, txnHash]
  );
  const txn = upd.rows[0];
  if (!txn) return res.status(400).json({ error: 'not_pending_or_not_found' });

  await logActivity(txn.telegram_id, 'withdrawal_approved', { id, type: txn.type });
  res.json({ ok: true, transaction: publicTxn(txn) });
});

// --- Admin: reject (fail) a withdrawal + exact-once refund ---------
app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
  const key = req.body.key || req.query.key || req.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  const id = parseInt(req.params.id, 10);
  const reason = String((req.body && req.body.reason) || 'rejected_by_admin').slice(0, 120);

  const upd = await db.query(
    `WITH moved AS (
       UPDATE transactions
          SET status='failed',
              failure_reason=$2,
              completed_at=COALESCE(completed_at, now())
        WHERE id=$1
          AND type IN ('eth_withdrawal','morpho_withdrawal')
          AND status IN ('processing','pending','confirming')
        RETURNING *
     ), refund AS (
       UPDATE users u
          SET morpho_balance = CASE WHEN moved.type='morpho_withdrawal' THEN u.morpho_balance + moved.amount ELSE u.morpho_balance END,
              eth_balance = CASE WHEN moved.type='eth_withdrawal' THEN u.eth_balance + moved.amount ELSE u.eth_balance END,
              last_active = now()
         FROM moved
        WHERE u.telegram_id = moved.telegram_id
        RETURNING moved.*
     )
     SELECT * FROM refund`,
    [id, reason]
  );

  const txn = upd.rows[0];
  if (!txn) return res.status(400).json({ error: 'not_pending_or_not_found' });

  await logActivity(txn.telegram_id, 'withdrawal_rejected', { id, type: txn.type, reason });
  res.json({ ok: true, transaction: publicTxn(txn) });
});

// --- Public config --------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    ethDepositMin: ETH_DEPOSIT_MIN,
    ethWithdrawMin: ETH_WITHDRAW_MIN,
    morphoEthGate: MORPHO_ETH_GATE,
    ethNetworkFee: ETH_NETWORK_FEE,
    ethDepositConfirmations: ETH_DEPOSIT_CONFIRMATIONS,
    ethDepositEtaText: ETH_DEPOSIT_ETA_TEXT,
    ethUsd: ETH_USD,
    nowpaymentsLive: !!NOWPAYMENTS_API_KEY,
    allowDevSimulation: ALLOW_DEV && !NOWPAYMENTS_API_KEY,
  });
});

// ---- Static SPA ---------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Boot ---------------------------------------------------------
db.ready
  .then(() => {
    app.listen(PORT, () => console.log(`[morpho] listening on :${PORT}`));
  })
  .catch((e) => {
    console.error('[morpho] failed to start:', e);
    process.exit(1);
  });
