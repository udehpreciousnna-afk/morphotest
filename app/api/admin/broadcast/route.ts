export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { broadcastJobs } from '@/lib/broadcast-jobs';

const ADMIN_KEY = process.env.ADMIN_KEY || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Channels the admin may post to. Configure via BROADCAST_CHANNELS (comma separated).
const BROADCAST_CHANNELS = (process.env.BROADCAST_CHANNELS || '@MantleMining')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function POST(req: Request) {
  const form = await req.formData();
  const key =
    (form.get('key') as string | null) ||
    new URL(req.url).searchParams.get('key') ||
    req.headers.get('x-admin-key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!BOT_TOKEN) {
    return NextResponse.json({ error: 'BOT_TOKEN not configured' }, { status: 400 });
  }

  const message = (form.get('message') as string | null)?.toString() || '';
  const mediaFile = form.get('media') as File | null;
  let mediaKind: 'photo' | 'video' | null = null;
  let mediaBuf: Buffer | null = null;
  let mediaType = '';
  let mediaName = '';
  if (mediaFile && typeof mediaFile === 'object' && 'arrayBuffer' in mediaFile) {
    mediaType = mediaFile.type || '';
    mediaName = mediaFile.name || '';
    if (/^image\//i.test(mediaType)) mediaKind = 'photo';
    else if (/^video\//i.test(mediaType)) mediaKind = 'video';
    else
      return NextResponse.json(
        { error: 'Unsupported media type \u2014 attach an image or a video.' },
        { status: 400 }
      );
    mediaBuf = Buffer.from(await mediaFile.arrayBuffer());
  }

  if (!message.trim() && !mediaBuf) {
    return NextResponse.json({ error: 'Add a message or attach a photo/video.' }, { status: 400 });
  }

  const target = (form.get('target') as string | null)?.toString() || 'all';
  if (target !== 'all' && !BROADCAST_CHANNELS.includes(target)) {
    return NextResponse.json({ error: 'invalid target' }, { status: 400 });
  }

  const buttonText = (form.get('buttonText') as string | null)?.toString().trim() || '';
  const buttonUrl = (form.get('buttonUrl') as string | null)?.toString().trim() || '';
  let reply_markup: any;
  if (buttonText && buttonUrl) {
    if (!/^https?:\/\//i.test(buttonUrl) && !/^tg:\/\//i.test(buttonUrl)) {
      return NextResponse.json(
        { error: 'button URL must start with http(s):// or tg://' },
        { status: 400 }
      );
    }
    reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
  }

  async function sendTo(chatId: string): Promise<{ ok: boolean; description?: string }> {
    let url: string;
    let body: any;
    let headers: Record<string, string> | undefined;
    if (mediaBuf && mediaKind) {
      const method = mediaKind === 'video' ? 'sendVideo' : 'sendPhoto';
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append(
        mediaKind,
        new Blob([new Uint8Array(mediaBuf)], { type: mediaType }),
        mediaName || (mediaKind === 'video' ? 'video.mp4' : 'photo.jpg')
      );
      if (message.trim()) {
        fd.append('caption', message);
        fd.append('parse_mode', 'HTML');
      }
      if (reply_markup) fd.append('reply_markup', JSON.stringify(reply_markup));
      url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
      body = fd;
    } else {
      const payload: any = { chat_id: chatId, text: message, parse_mode: 'HTML' };
      if (reply_markup) payload.reply_markup = reply_markup;
      url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }
    try {
      const r = await fetch(url, { method: 'POST', headers, body });
      let j: any = null;
      try {
        j = await r.json();
      } catch {}
      if (r.ok && j && j.ok) return { ok: true };
      return { ok: false, description: (j && j.description) || `HTTP ${r.status}` };
    } catch (e: any) {
      return { ok: false, description: String((e && e.message) || e) };
    }
  }

  // Single channel post: keep synchronous.
  if (target !== 'all') {
    const r = await sendTo(target);
    if (r.ok) return NextResponse.json({ channel: target, ok: true });
    return NextResponse.json(
      { error: `Could not post to ${target}: ${r.description}` },
      { status: 400 }
    );
  }

  // Mass broadcast: start background job, respond immediately.
  const jobId = crypto.randomUUID();
  broadcastJobs[jobId] = {
    status: 'running',
    total: 0,
    sent: 0,
    blocked: 0,
    failed: 0,
    reasons: {},
    startedAt: Date.now(),
  };

  // Background execution (fire-and-forget).
  (async () => {
    const job = broadcastJobs[jobId];
    try {
      const rows = await prisma.gameUser.findMany({ select: { telegramId: true } });
      job.total = rows.length;
      const CONCURRENCY = 20;
      let idx = 0;
      async function worker() {
        while (idx < rows.length) {
          const i = idx++;
          const r = await sendTo(rows[i].telegramId);
          if (r.ok) job.sent++;
          else {
            const d = r.description || 'unknown error';
            if (/blocked|deactivated|can't initiate|not found|chat not found/i.test(d))
              job.blocked++;
            else job.failed++;
            job.reasons[d] = (job.reasons[d] || 0) + 1;
          }
          await new Promise((f) => setTimeout(f, mediaBuf ? 60 : 25));
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = String(e);
    }
  })();

  return NextResponse.json({ jobId, started: true });
}
