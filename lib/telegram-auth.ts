import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const ALLOW_DEV = process.env.ALLOW_DEV !== 'false';

export function validateInitData(initData: string | null | undefined) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    const user = JSON.parse(params.get('user') ?? 'null');
    if (!user?.id) return null;
    return { user, start_param: params.get('start_param') ?? null };
  } catch {
    return null;
  }
}

export function resolveIdentity(body: any) {
  const { initData, devUser, startParam } = body ?? {};
  const v = validateInitData(initData);
  if (v) {
    return {
      id: String(v.user.id),
      user: v.user,
      start_param: v.start_param ?? startParam ?? null,
      verified: true,
    };
  }
  if (ALLOW_DEV && devUser?.id) {
    return {
      id: String(devUser.id),
      user: devUser,
      start_param: startParam ?? null,
      verified: false,
    };
  }
  return null;
}

export async function isChatMember(chat: string, userId: string) {
  if (!BOT_TOKEN) return { checked: false, member: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, user_id: Number(userId) }),
    });
    const data = await r.json();
    if (!data?.ok) return { checked: false, member: false };
    const status = data?.result?.status;
    return { checked: true, member: ['creator', 'administrator', 'member', 'restricted'].includes(status) };
  } catch {
    return { checked: false, member: false };
  }
}
