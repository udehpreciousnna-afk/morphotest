export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveIdentity } from '@/lib/telegram-auth';
import { publicUser, computeState } from '@/lib/game-helpers';
import { MAX_ENERGY } from '@/lib/game-config';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const idn = resolveIdentity(body);
    if (!idn) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let taps = parseInt(body?.taps, 10);
    if (!Number.isFinite(taps) || taps <= 0) taps = 0;
    taps = Math.min(taps, MAX_ENERGY);

    let row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });
    if (!row) return NextResponse.json({ error: 'no_user' }, { status: 404 });

    const st = computeState(row);
    let energy = st.energy;
    let timerStart = st.timerStart;

    const allowed = Math.min(taps, energy);
    if (allowed > 0) {
      if (timerStart == null) timerStart = Date.now();
      energy -= allowed;
      let gained = 0;
      for (let i = 0; i < allowed; i++) gained += Math.round((0.010 + Math.random() * 0.089) * 1000) / 1000;
      gained = Math.round(gained * 1000) / 1000;
      row = await prisma.gameUser.update({
        where: { telegramId: idn.id },
        data: {
          mantleBalance: { increment: gained },
          energy,
          timerStart: timerStart != null ? BigInt(timerStart) : null,
          totalTaps: { increment: allowed },
          lastActive: new Date(),
        },
      });
    } else if (st.changed) {
      await prisma.gameUser.update({
        where: { telegramId: idn.id },
        data: { energy, timerStart: timerStart != null ? BigInt(timerStart) : null },
      });
      row = { ...row, energy, timerStart: timerStart != null ? BigInt(timerStart) : null };
    }

    return NextResponse.json({ user: publicUser(row) });
  } catch (e: any) {
    console.error('[api/tap]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
