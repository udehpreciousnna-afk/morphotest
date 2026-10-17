// Game economy constants
export const MAX_ENERGY = 1000;
export const REFILL_MS = 5 * 60 * 60 * 1000; // 5 hours
export const TAP_MIN = 0.010;              // min MANTLE per tap
export const TAP_MAX = 0.099;              // max MANTLE per tap
export const WELCOME_BONUS = 20;             // new user starts with 20 MANTLE
export const REFERRAL_REWARD = 15;            // referrer earns 15 MANTLE per referral
export const DAILY_REWARDS = [2, 5, 8, 10, 12, 15, 20];
export const WITHDRAW_MIN_REFS = 1;

export const TASKS: Record<number, { reward: number; eth: number; chat?: string }> = {
  1: { reward: 5, eth: 0.001, chat: '@MantleMining' },
  2: { reward: 2, eth: 0.0005, chat: '@Crypto365team' },
  3: { reward: 2, eth: 0.0005 },
  4: { reward: 1, eth: 0 },
  5: { reward: 1, eth: 0 },
};
