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

let tickTimer: NodeJS.Timeout | null = null;
let rotateTimer: NodeJS.Timeout | null = null;
let ticks = 0;
let rotating = false;
let lastTickAt: number | null = null;
let lastRotateAt: number | null = null;

async function tick() {
  try {
    lastTickAt = Date.now();
    const due = await findDue();
    for (const { entry, userId } of due) {
      const { entry: fired, repeat } = await markFired(entry, userId);
      log.info('fired', {
        id: fired.id,
        text: fired.text.slice(0, 40),
        strength: fired.strength,
        repeat,
        bypassQuiet: fired.bypassQuiet,
      });
    }

    if (++ticks % 60 === 0) {
      const offline = await sweepOffline();
      const byUser = new Map<string, string[]>();
      for (const d of offline) {
        await touchDevice(d.id, false);
        if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
        byUser.get(d.user_id)!.push(d.id);
      }
      for (const userId of byUser.keys()) {
        hub.broadcastToUser(userId, { t: 'devices.changed', devices: await listDevices(userId) });
      }
      for (const d of offline) log.info('device offline', { id: d.id });
      await purgeSettled();
    }
  } catch (err) {
    log.error('scheduler tick failed', err);
  }
}

async function rotate() {
  if (rotating) return;
  rotating = true;
  lastRotateAt = Date.now();
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

export function schedulerStats() {
  return {
    connections: hub.connectionCount,
    tickMs: env.TICK_MS,
    rotateMs: env.ROTATE_MS,
    ticks,
    lastTickAt,
    lastRotateAt,
    rotating,
  };
}

export { makeFireKey, invalidateTransport };
export type { ServerMessage, Settings };
