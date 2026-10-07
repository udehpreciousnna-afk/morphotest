export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveIdentity } from '@/lib/telegram-auth';
import { publicUser } from '@/lib/game-helpers';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const idn = resolveIdentity(body);
    if (!idn) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const key = String(body?.wallet ?? '').toLowerCase();
    const address = String(body?.address ?? '').trim();
    const valid = ['trustwallet', 'binance', 'bitget', 'okx', 'bybit'];
    if (!valid.includes(key) || !address) {
      return NextResponse.json({ error: 'bad_wallet' }, { status: 400 });
    }

    let row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });
    if (!row) return NextResponse.json({ error: 'no_user' }, { status: 404 });

    const wallets = (row.wallets && typeof row.wallets === 'object') ? { ...(row.wallets as Record<string, string>) } : {};
    wallets[key] = address;

    row = await prisma.gameUser.update({
      where: { telegramId: idn.id },
      data: { wallets, lastActive: new Date() },
    });

    await prisma.activity.create({
      data: { telegramId: idn.id, type: 'wallet', detail: { wallet: key } },
    });

    return NextResponse.json({ user: publicUser(row) });
  } catch (e: any) {
    console.error('[api/wallet]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
