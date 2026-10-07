import { REFILL_MS, MAX_ENERGY, DAILY_REWARDS } from './game-config';
import type { GameUser } from '@prisma/client';

export function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function todayStr(): string {
  return toDateStr(new Date());
}
export function yesterdayStr(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateStr(d);
}

function lastClaimStr(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return toDateStr(v);
  return String(v).slice(0, 10);
}

export function dailyStatus(row: GameUser) {
  const last = lastClaimStr(row.lastClaimDate);
  const streak = Number(row.dailyStreak ?? 0);
  const today = todayStr();
  const canClaim = last !== today;
  let nextDay: number;
  if (!canClaim) {
    nextDay = ((streak - 1 + 7) % 7) + 1;
  } else if (last === yesterdayStr() && streak > 0) {
    nextDay = (streak % 7) + 1;
  } else {
    nextDay = 1;
  }
  return { dailyStreak: streak, dailyCanClaim: canClaim, dailyNextDay: nextDay };
}

export function computeState(row: GameUser) {
  let energy = row.energy;
  let timerStart = row.timerStart != null ? Number(row.timerStart) : null;
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

export function publicUser(row: GameUser, extra: Record<string, any> = {}) {
  const st = computeState(row);
  return {
    telegramId: row.telegramId,
    username: row.username,
    firstName: row.firstName,
    balance: Number(row.mantleBalance),
    ethBalance: Number(row.ethBalance ?? 0),
    energy: st.energy,
    maxEnergy: MAX_ENERGY,
    timerRemaining: st.remaining,
    ready: st.timerStart == null,
    referralCount: row.referralCount,
    referredBy: row.referredBy,
    completedTasks: row.completedTasks ?? [],
    wallets: row.wallets ?? {},
    totalTaps: Number(row.totalTaps),
    createdAt: row.createdAt,
    lastActive: row.lastActive,
    perTap: 0.008,
    refillMs: REFILL_MS,
    dailyRewards: DAILY_REWARDS,
    ...dailyStatus(row),
    ...extra,
  };
}
