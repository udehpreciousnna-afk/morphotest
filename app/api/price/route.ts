export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';

let priceCache = { usd: 1.18, ts: 0 };

export async function GET() {
  if (Date.now() - priceCache.ts < 60_000 && priceCache.ts !== 0) {
    return NextResponse.json({ usd: priceCache.usd });
  }
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
  return NextResponse.json({ usd: priceCache.usd });
}
