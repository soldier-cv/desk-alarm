import type { ServerMessage, Settings } from '../../shared/types.js';
import { env } from './env.js';
import { hub } from './hub.js';
import { log } from './log.js';
import { findDue, markFired } from './repo/entries.js';
import {
  deliverBatch, makeFireKey, purgeSettled, sweepStale, takePending,
} from './repo/deliveries.js';
import { listDevices, sweepOffline, touchDevice } from './repo/devices.js';
import { invalidateTransport } from './repo/deliveries.js';
import { getSettings } from './repo/settings.js';

let tickTimer: NodeJS.Timeout | null = null;
let rotateTimer: NodeJS.Timeout | null = null;
let ticks = 0;
let rotating = false;

/**
 * 调度器：整个系统里唯一决定「这条提醒响了没有」的地方。
 *
 * 它只写 outbox，不自己投递。投递交给轮转器。
 * 这样「什么时候判定响」和「怎么送出去」是两件独立的事，
 * 加新的投递通道不会动到判定逻辑。
 */
async function tick() {
  try {
    const due = await findDue();
    for (const { entry } of due) {
      const { entry: fired, repeat } = await markFired(entry);
      log.info('fired', {
        id: fired.id,
        text: fired.text.slice(0, 40),
        strength: fired.strength,
        repeat,
        bypassQuiet: fired.bypassQuiet,
      });
    }

    if (++ticks % 60 === 0) {
      for (const d of await sweepOffline()) {
        await touchDevice(d.id, false);
        hub.broadcast({ t: 'devices.changed', devices: await listDevices() });
        log.info('device offline', { id: d.id });
      }
      await purgeSettled();
    }
  } catch (err) {
    log.error('scheduler tick failed', err);
  }
}

/**
 * 投递轮转器：把 outbox 里的 pending 投出去。
 *
 * 关键规则：delivered 的判定标准是「通道确认接收」，不是「我发出去了」。
 * 这条线划错了，后面的补发逻辑全会跟着错。
 */
async function rotate() {
  if (rotating) return; // 上一轮还没跑完，跳过，别叠起来
  rotating = true;
  try {
    const batch = await takePending();
    if (batch.length === 0) {
      if (++ticks % 30 === 0) await sweepStale();
      return;
    }
    const r = await deliverBatch(batch);
    if (r.ok > 0) {
      log.info('delivered', { ok: r.ok, fail: r.fail, by: r.byTransport });
    }
  } catch (err) {
    log.error('rotate failed', err);
  } finally {
    rotating = false;
  }
}

export function startScheduler() {
  if (tickTimer) return;
  log.info('scheduler', { tickMs: env.TICK_MS, rotateMs: env.ROTATE_MS });
  tickTimer = setInterval(() => void tick(), env.TICK_MS);
  tickTimer.unref?.();
  rotateTimer = setInterval(() => void rotate(), env.ROTATE_MS);
  rotateTimer.unref?.();
  void tick();
}

export function stopScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  if (rotateTimer) clearInterval(rotateTimer);
  tickTimer = null;
  rotateTimer = null;
}

export async function schedulerStats() {
  return {
    connections: hub.connectionCount,
    tickMs: env.TICK_MS,
    rotateMs: env.ROTATE_MS,
    settings: await getSettings(),
  };
}

export { makeFireKey, invalidateTransport };
export type { ServerMessage, Settings };
