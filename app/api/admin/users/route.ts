export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { publicUser } from '@/lib/game-helpers';

const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Whitelist of sortable columns -> Prisma field names.
const SORT_COLS: Record<string, string> = {
  balance: 'mantleBalance',
  referrals: 'referralCount',
  taps: 'totalTaps',
  joined: 'createdAt',
  active: 'lastActive',
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  if (!ADMIN_KEY || searchParams.get('key') !== ADMIN_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10) || 100, 1000);
  const offset = parseInt(searchParams.get('offset') || '0', 10) || 0;
  const sortCol = SORT_COLS[searchParams.get('sort') || ''] || 'lastActive';
  const dir = (searchParams.get('dir') || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const search = (searchParams.get('search') || '').trim();

  const where = search
    ? {
        OR: [
          { username: { contains: search, mode: 'insensitive' as const } },
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { telegramId: { contains: search } },
        ],
      }
    : {};

  try {
    const [rows, total] = await Promise.all([
      prisma.gameUser.findMany({
        where,
        orderBy: [{ [sortCol]: dir }, { telegramId: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.gameUser.count({ where }),
    ]);

    return NextResponse.json({
      total,
      count: rows.length,
      users: rows.map((r) => publicUser(r)),
    });
  } catch (e) {
    console.error('[admin/users] error:', e);
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }
}
