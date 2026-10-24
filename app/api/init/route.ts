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
let priceRefreshing = false;
async function refreshPrice() {
  if (priceRefreshing) return;
  priceRefreshing = true;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=mantle&vs_currencies=usd', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    const j = await res.json();
    const usd = j?.mantle?.usd ?? priceCache.usd;
    priceCache = { usd, ts: Date.now() };
  } catch {
    priceCache.ts = Date.now();
  } finally {
    priceRefreshing = false;
  }
}
// Never block /api/init on the third-party price API: return the cached value
// immediately and refresh it in the background when stale.
function getPrice() {
  if (priceCache.ts === 0 || Date.now() - priceCache.ts >= 60_000) void refreshPrice();
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
      try {
        let raw = String(idn.start_param ?? '').trim();
        if (/^ref_/i.test(raw)) raw = raw.slice(4);
        if (raw && raw !== idn.id) {
          const ref = await prisma.gameUser.findUnique({ where: { telegramId: raw } });
          if (ref) referredBy = raw;
        }
      } catch (err) {
        console.error('[api/init] referrer lookup', err);
      }

      let created = false;
      try {
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
        created = true;
      } catch (err) {
        // Concurrent/duplicate init (e.g. client retry): the user already exists, just load it.
        row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });
        if (!row) throw err;
      }

      if (created) {
        // Activity log + referral credit must never block the user from loading.
        prisma.activity.create({
          data: { telegramId: idn.id, type: 'signup', detail: { welcome: WELCOME_BONUS, referredBy } },
        }).catch((err) => console.error('[api/init] signup activity', err));

        if (referredBy) {
          try {
            await prisma.gameUser.update({
              where: { telegramId: referredBy },
              data: {
                referralCount: { increment: 1 },
                mantleBalance: { increment: REFERRAL_REWARD },
              },
            });
            prisma.activity.create({
              data: { telegramId: referredBy, type: 'referral', detail: { newUser: idn.id, reward: REFERRAL_REWARD } },
            }).catch((err) => console.error('[api/init] referral activity', err));
          } catch (err) {
            console.error('[api/init] referral credit', err);
          }
        }
      }
    } else {
      const st = computeState(row);
      // Fire-and-forget: the response is built from the in-memory values below,
      // so the client doesn't need to wait for this write.
      prisma.gameUser.update({
        where: { telegramId: idn.id },
        data: {
          username: idn.user?.username ?? row.username,
          firstName: idn.user?.first_name ?? row.firstName,
          energy: st.energy,
          timerStart: st.timerStart != null ? BigInt(st.timerStart) : null,
          lastActive: new Date(),
        },
      }).catch((err) => console.error('[api/init] update', err));
      row = { ...row, energy: st.energy, timerStart: st.timerStart != null ? BigInt(st.timerStart) : null };
    }

    const price = getPrice();
    const refLink = `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}?startapp=REF_${idn.id}`;
    return NextResponse.json({ user: publicUser(row, { verified: idn.verified }), price, refLink });
  } catch (e: any) {
    console.error('[api/init]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
