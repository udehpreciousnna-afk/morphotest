export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { broadcastJobs } from '@/lib/broadcast-jobs';

const ADMIN_KEY = process.env.ADMIN_KEY || '';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { searchParams } = new URL(req.url);
  if (!ADMIN_KEY || searchParams.get('key') !== ADMIN_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { jobId } = await params;
  const job = broadcastJobs[jobId];
  if (!job) return NextResponse.json({ error: 'job_not_found' }, { status: 404 });
  return NextResponse.json(job);
}
