import { driveTick, engineStats } from './drive.js';
import { env } from './env.js';
import { log } from './log.js';
import { getPursuit } from './repo/pursuits.js';
import { markDelivered, markFailed, takePending, type PendingNudge } from './repo/nudges.js';
import { send as sendNudge } from './transport/index.js';
import { hub } from './hub.js';

let tickTimer: NodeJS.Timeout | null = null;
let rotateTimer: NodeJS.Timeout | null = null;
let ticks = 0;
let rotating = false;
let lastTickAt: number | null = null;

async function tick(): Promise<void> {
  lastTickAt = Date.now();
  try {
    await driveTick();
    ticks++;
  } catch (err) {
    log.error('drive tick failed', err);
  }
}

async function rotate(): Promise<void> {
  if (rotating) return;
  rotating = true;
  try {
    const batch = await takePending(100) as PendingNudge[];
    for (const n of batch) {
      const deviceId = n.device_id;
      try {
        const pursuit = await getPursuit(n.pursuitId, n.userId);
        if (!pursuit) {
          await markFailed(n.id, '推进项已不存在');
          continue;
        }
        // device_id 为 null 表示「推送范围=全部在线设备」。一台都不在线时保持 pending，
        // 否则会 markDelivered 让这条永远进不了 missed，用户再也收不到
        if (!deviceId) {
          if (!hub.hasOnline(n.userId)) {
            await markFailed(n.id, '设备不在线');
            continue;
          }
          hub.broadcastToUser(n.userId, {
            t: 'pursuit.nudge', pursuit,
            level: n.level, channel: n.channel, reason: n.reason, serverTs: Date.now(),
          });
          await markDelivered(n.id);
          continue;
        }
        const result = await sendNudge(deviceId, {
          pursuit,
          level: n.level,
          channel: n.channel,
          reason: n.reason,
          serverTs: Date.now(),
        });
        if (result.ok) await markDelivered(n.id);
        else await markFailed(n.id, result.error ?? '投递失败');
      } catch (err) {
        await markFailed(n.id, (err as Error).message);
      }
    }
  } catch (err) {
    log.error('nudge rotate failed', err);
  } finally {
    rotating = false;
  }
}

export function startScheduler(): void {
  if (tickTimer) return;
  log.info('scheduler', { tickMs: env.TICK_MS, rotateMs: env.ROTATE_MS });
  tickTimer = setInterval(() => void tick(), env.TICK_MS);
  tickTimer.unref?.();
  rotateTimer = setInterval(() => void rotate(), env.ROTATE_MS);
  rotateTimer.unref?.();
  void tick();
}

export function stopScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (rotateTimer) clearInterval(rotateTimer);
  tickTimer = null;
  rotateTimer = null;
}

export function schedulerStats(): {
  tickMs: number; ticks: number; lastTickAt: number | null; active: number; stalled: number;
} {
  return {
    tickMs: env.TICK_MS,
    ticks,
    lastTickAt,
    active: engineStats.active,
    stalled: engineStats.stalled,
  };
}
