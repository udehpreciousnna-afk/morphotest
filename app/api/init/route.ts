export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveIdentity } from '@/lib/telegram-auth';
import { publicUser, computeState } from '@/lib/game-helpers';
import { WELCOME_BONUS, REFERRAL_REWARD, MAX_ENERGY } from '@/lib/game-config';

const BOT_USERNAME = process.env.BOT_USERNAME ?? 'MantleMiningBot';
const APP_SHORT_NAME = process.env.APP_SHORT_NAME ?? 'myapp';

// Price cache
let priceCache = { usd: 1.18, ts: 0 };
async function getPrice() {
  if (Date.now() - priceCache.ts < 60_000 && priceCache.ts !== 0) return priceCache.usd;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=mantle&vs_currencies=usd', {
      headers: { accept: 'application/json' },
    });
    const j = await res.json();
    const usd = j?.mantle?.usd ?? priceCache.usd;
    priceCache = { usd, ts: Date.now() };
  } catch {
    priceCache.ts = Date.now();
  }
  return priceCache.usd;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const idn = resolveIdentity(body);
    if (!idn) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });

    if (!row) {
      let referredBy: string | null = null;
      let raw = idn.start_param ?? '';
      if (raw.startsWith('REF_')) raw = raw.slice(4);
      if (raw && raw !== idn.id) {
        const ref = await prisma.gameUser.findUnique({ where: { telegramId: raw } });
        if (ref) referredBy = raw;
      }

      row = await prisma.gameUser.create({
        data: {
          telegramId: idn.id,
          username: idn.user?.username ?? null,
          firstName: idn.user?.first_name ?? 'Miner',
          photoUrl: idn.user?.photo_url ?? null,
          mantleBalance: WELCOME_BONUS,
          energy: MAX_ENERGY,
          referredBy,
        },
      });

      await prisma.activity.create({
        data: { telegramId: idn.id, type: 'signup', detail: { welcome: WELCOME_BONUS, referredBy } },
      });

      if (referredBy) {
        await prisma.gameUser.update({
          where: { telegramId: referredBy },
          data: {
            referralCount: { increment: 1 },
            mantleBalance: { increment: REFERRAL_REWARD },
          },
        });
        await prisma.activity.create({
          data: { telegramId: referredBy, type: 'referral', detail: { newUser: idn.id, reward: REFERRAL_REWARD } },
        });
      }
    } else {
      const st = computeState(row);
      await prisma.gameUser.update({
        where: { telegramId: idn.id },
        data: {
          username: idn.user?.username ?? row.username,
          firstName: idn.user?.first_name ?? row.firstName,
          energy: st.energy,
          timerStart: st.timerStart != null ? BigInt(st.timerStart) : null,
          lastActive: new Date(),
        },
      });
      row = { ...row, energy: st.energy, timerStart: st.timerStart != null ? BigInt(st.timerStart) : null };
    }

    const price = await getPrice();
    const refLink = `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=REF_${idn.id}`;
    return NextResponse.json({ user: publicUser(row, { verified: idn.verified }), price, refLink });
  } catch (e: any) {
    console.error('[api/init]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
