export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveIdentity } from '@/lib/telegram-auth';
import { publicUser, dailyStatus, todayStr } from '@/lib/game-helpers';
import { DAILY_REWARDS } from '@/lib/game-config';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const idn = resolveIdentity(body);
    if (!idn) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });
    if (!row) return NextResponse.json({ error: 'no_user' }, { status: 404 });

    const st = dailyStatus(row);
    if (!st.dailyCanClaim) {
      return NextResponse.json({ user: publicUser(row), already: true });
    }
    const day = st.dailyNextDay;
    const reward = DAILY_REWARDS[day - 1] ?? 0;

    row = await prisma.gameUser.update({
      where: { telegramId: idn.id },
      data: {
        mantleBalance: { increment: reward },
        dailyStreak: day,
        lastClaimDate: new Date(todayStr()),
        lastActive: new Date(),
      },
    });

    await prisma.activity.create({
      data: { telegramId: idn.id, type: 'daily', detail: { day, reward } },
    });

    return NextResponse.json({ user: publicUser(row), claimedDay: day, reward });
  } catch (e: any) {
    console.error('[api/daily/claim]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
