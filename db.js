/**
 * MORPHO — Database layer
 * ------------------------------------------------------------------
 * Uses real PostgreSQL (via `pg`) in production when DATABASE_URL is set
 * (e.g. on Render). Falls back to an in-process PGlite instance for local
 * development/testing when DATABASE_URL is not provided.
 *
 * Both backends expose a common async `query(sql, params)` returning
 * an object shaped like `{ rows: [...] }`, so the rest of the app is
 * database-agnostic.
 */

const USE_PG = !!process.env.DATABASE_URL;

let backend = null;      // holds the pg Pool or the PGlite instance
let ready = null;        // promise that resolves once schema is created

// ---- Query helper -------------------------------------------------
async function query(sql, params = []) {
  await ready;
  if (USE_PG) {
    return backend.query(sql, params);
  }
  // PGlite uses $1, $2 placeholders just like pg
  return backend.query(sql, params);
}

// ---- Schema -------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id      TEXT PRIMARY KEY,
  username         TEXT,
  first_name       TEXT,
  photo_url        TEXT,
  morpho_balance   DOUBLE PRECISION DEFAULT 10,
  eth_balance      DOUBLE PRECISION DEFAULT 0,
  energy           INTEGER DEFAULT 1000,
  timer_start      BIGINT,
  referral_count   INTEGER DEFAULT 0,
  referred_by      TEXT,
  completed_tasks  JSONB DEFAULT '[]',
  wallets          JSONB DEFAULT '{}',
  total_taps       BIGINT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now(),
  last_active      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id           SERIAL PRIMARY KEY,
  telegram_id  TEXT,
  type         TEXT,
  detail       JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
`;

// Migration(s) to run AFTER schema creation so existing (production) tables
// gain new columns. Executed as its own statement for both backends.
const MIGRATION = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS eth_balance DOUBLE PRECISION DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_claim_date DATE;

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'eth_deposit', 'eth_withdrawal', 'morpho_withdrawal'
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,        -- 'ETH' or 'MORPHO'
  status TEXT NOT NULL,          -- 'awaiting', 'detected', 'confirming', 'processing', 'completed', 'failed'
  payment_id TEXT,               -- NowPayments payment ID
  payment_address TEXT,          -- deposit address or withdrawal destination
  txn_hash TEXT,                 -- blockchain transaction hash
  network TEXT,
  provider TEXT,
  confirmations INTEGER DEFAULT 0,
  fee DOUBLE PRECISION,
  failure_reason TEXT,
  idempotency_key TEXT,
  confirmed_at TIMESTAMPTZ,
  received_amount DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS network TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmations INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee DOUBLE PRECISION;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS received_amount DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_id ON transactions(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_user_idempotency ON transactions(telegram_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

async function bootstrap() {
  if (USE_PG) {
    const { Pool } = require('pg');
    const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
    backend = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 10,
    });
    await backend.query(SCHEMA);
    await backend.query(MIGRATION);
    console.log('[db] Connected to PostgreSQL');
  } else {
    // Local dev / testing fallback
    const { PGlite } = require('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || '/tmp/morpho-pglite';
    backend = new PGlite(dir);
    await backend.waitReady;
    await backend.exec(SCHEMA);
    await backend.exec(MIGRATION);
    console.log('[db] Using local PGlite store at', dir);
  }
}

// Kick off bootstrap immediately and expose the promise
ready = bootstrap();

module.exports = { query, ready };
