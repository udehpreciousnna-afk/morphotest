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
  const media = req.file || null; // { buffer, mimetype, originalname, size }

  // Classify media
  let mediaKind = null; // 'photo' | 'video'
  if (media) {
    if (/^image\//i.test(media.mimetype)) mediaKind = 'photo';
    else if (/^video\//i.test(media.mimetype)) mediaKind = 'video';
    else return res.status(400).json({ error: 'Unsupported media type — attach an image or a video.' });
  }

  // Need at least text or media
  if (!message.trim() && !media) {
    return res.status(400).json({ error: 'Add a message or attach a photo/video.' });
  }

  const target = (req.body.target || 'all').toString();
  if (target !== 'all' && !BROADCAST_CHANNELS.includes(target)) {
    return res.status(400).json({ error: 'invalid target' });
  }

  // Optional inline button
  const buttonText = (req.body.buttonText || '').toString().trim();
  const buttonUrl = (req.body.buttonUrl || '').toString().trim();
  let reply_markup;
  if (buttonText && buttonUrl) {
    if (!/^https?:\/\//i.test(buttonUrl) && !/^tg:\/\//i.test(buttonUrl)) {
      return res.status(400).json({ error: 'button URL must start with http(s):// or tg://' });
    }
    reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
  }

  // Build a single Telegram send to a given chat_id. Returns { ok, description }.
  async function sendTo(chatId) {
    let url, body, headers;
    if (media) {
      // Photos/videos must be sent with sendPhoto/sendVideo as multipart.
      const method = mediaKind === 'video' ? 'sendVideo' : 'sendPhoto';
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(mediaKind, new Blob([media.buffer], { type: media.mimetype }),
        media.originalname || (mediaKind === 'video' ? 'video.mp4' : 'photo.jpg'));
      if (message.trim()) { form.append('caption', message); form.append('parse_mode', 'HTML'); }
      if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
      url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
      body = form; // fetch sets multipart boundary automatically
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

  try {
    // ── Post to a channel (single message) ──
    if (target !== 'all') {
      const r = await sendTo(target);
      if (r.ok) return res.json({ channel: target, ok: true });
      return res.status(400).json({ error: `Could not post to ${target}: ${r.description}` });
    }

    // ── Broadcast to all users (DM each) ──
    const { rows } = await db.query('SELECT telegram_id FROM users');
    let sent = 0, blocked = 0, failed = 0;
    const errorSamples = {}; // description -> count
    for (const { telegram_id } of rows) {
      const r = await sendTo(telegram_id);
      if (r.ok) { sent++; }
      else {
        const d = (r.description || 'unknown error');
        if (/blocked|deactivated|can't initiate|not found|chat not found/i.test(d)) blocked++;
        else failed++;
        errorSamples[d] = (errorSamples[d] || 0) + 1;
      }
      await new Promise(f => setTimeout(f, media ? 120 : 40)); // slower for media (heavier)
    }
    // Top few distinct error reasons, so failures are diagnosable.
    const reasons = Object.entries(errorSamples)
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([d, c]) => `${d} (${c})`);
    res.json({ total: rows.length, sent, blocked, failed, reasons });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
