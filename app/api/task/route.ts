export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveIdentity, isChatMember } from '@/lib/telegram-auth';
import { publicUser } from '@/lib/game-helpers';
import { TASKS } from '@/lib/game-config';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const idn = resolveIdentity(body);
    if (!idn) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    const taskId = parseInt(body?.taskId, 10);
    const task = TASKS[taskId];
    if (!task) return NextResponse.json({ error: 'bad_task' }, { status: 400 });

    let row = await prisma.gameUser.findUnique({ where: { telegramId: idn.id } });
    if (!row) return NextResponse.json({ error: 'no_user' }, { status: 404 });

    const done = Array.isArray(row.completedTasks) ? (row.completedTasks as number[]) : [];
    if (done.includes(taskId)) {
      return NextResponse.json({ user: publicUser(row), already: true });
    }

    if (task.chat && idn.verified) {
      const chk = await isChatMember(task.chat, idn.id);
      if (chk.checked && !chk.member) {
        return NextResponse.json({ error: 'not_member' }, { status: 403 });
      }
    }

    done.push(taskId);
    row = await prisma.gameUser.update({
      where: { telegramId: idn.id },
      data: {
        completedTasks: done,
        mantleBalance: { increment: task.reward },
        ethBalance: { increment: task.eth },
        lastActive: new Date(),
      },
    });

    await prisma.activity.create({
      data: { telegramId: idn.id, type: 'task', detail: { taskId, reward: task.reward, eth: task.eth } },
    });

    return NextResponse.json({ user: publicUser(row), reward: task.reward, ethReward: task.eth });
  } catch (e: any) {
    console.error('[api/task]', e);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
