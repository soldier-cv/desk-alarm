import type { Overview } from '../../../shared/types.js';
import { one, rows } from '../db.js';
import { schedulerStats } from '../scheduler.js';

export async function getOverview(): Promise<Overview> {
  const entryRow = await one<{
    total: number; pending: number; missed: number; inbox: number; done: number; neglected: number;
  }>(`
    SELECT count(*)::int AS total,
      count(*) FILTER (
        WHERE done_at IS NULL AND remind_at IS NOT NULL
          AND (fired_at IS NULL OR remind_at > fired_at)
      )::int AS pending,
      count(*) FILTER (
        WHERE done_at IS NULL AND remind_at IS NOT NULL
          AND fired_at IS NOT NULL AND remind_at <= fired_at
      )::int AS missed,
      count(*) FILTER (WHERE done_at IS NULL AND remind_at IS NULL)::int AS inbox,
      count(*) FILTER (WHERE done_at IS NOT NULL)::int AS done,
      count(*) FILTER (WHERE done_at IS NULL AND dismiss_count >= 2)::int AS neglected
    FROM entries
  `);

  const byState: Record<string, number> = {};
  for (const r of await rows<{ state: string; n: number }>(
    'SELECT state, count(*)::int AS n FROM deliveries GROUP BY state',
  )) byState[r.state] = r.n;

  const byTransport: Record<string, number> = {};
  for (const r of await rows<{ transport: string; n: number }>(
    `SELECT COALESCE(transport, 'none') AS transport, count(*)::int AS n
       FROM deliveries GROUP BY transport`,
  )) byTransport[r.transport] = r.n;

  const recentErrors = (await rows<{
    entry_id: string; device_id: string; last_error: string; last_attempt_at: Date;
  }>(
    `SELECT entry_id, device_id, last_error, last_attempt_at
       FROM deliveries
      WHERE last_error IS NOT NULL
      ORDER BY last_attempt_at DESC NULLS LAST LIMIT 10`,
  )).map((r) => ({
    entryId: r.entry_id,
    deviceId: r.device_id,
    error: r.last_error,
    at: new Date(r.last_attempt_at).getTime(),
  }));

  const deviceRow = await one<{ total: number; online: number }>(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE online)::int AS online FROM devices',
  );
  const byPlatform: Record<string, number> = {};
  for (const r of await rows<{ platform: string; n: number }>(
    'SELECT platform, count(*)::int AS n FROM devices GROUP BY platform',
  )) byPlatform[r.platform] = r.n;

  const userRow = await one<{ total: number }>('SELECT count(*)::int AS total FROM users');
  const sched = schedulerStats();

  return {
    serverTs: Date.now(),
    uptimeMs: Math.round(process.uptime() * 1000),
    db: { ok: true },
    scheduler: {
      tickMs: sched.tickMs,
      rotateMs: sched.rotateMs,
      ticks: sched.ticks,
      lastTickAt: sched.lastTickAt,
      lastRotateAt: sched.lastRotateAt,
      rotating: sched.rotating,
    },
    entries: {
      total: entryRow?.total ?? 0,
      pending: entryRow?.pending ?? 0,
      missed: entryRow?.missed ?? 0,
      inbox: entryRow?.inbox ?? 0,
      done: entryRow?.done ?? 0,
      neglected: entryRow?.neglected ?? 0,
    },
    deliveries: { byState, byTransport, recentErrors },
    devices: {
      total: deviceRow?.total ?? 0,
      online: deviceRow?.online ?? 0,
      byPlatform,
    },
    users: { total: userRow?.total ?? 0 },
  };
}
