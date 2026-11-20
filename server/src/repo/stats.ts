import type { MyStats, Overview } from '../../../shared/types.js';
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

/**
 * 单用户看板。PG 连接固定 timezone=UTC，所以 now()::date 就是项目的 UTC 日界线。
 * due 按 fired_at（响过）或 remind_at（还没响）落日，done/missed 按各自时刻落日。
 */
export async function getMyStats(userId: string): Promise<MyStats> {
  const daily = await rows<{ day: string; due: number; done: number; missed: number }>(
    `WITH d AS (
       SELECT generate_series((now()::date - interval '59 days')::date,
                              now()::date, interval '1 day')::date AS day
     )
     SELECT t.day::text AS day,
       (SELECT count(*)::int FROM entries e
         WHERE e.user_id = $1
           AND date(coalesce(e.fired_at, e.remind_at)) = t.day
           AND coalesce(e.fired_at, e.remind_at) <= now()) AS due,
       (SELECT count(*)::int FROM entries e
         WHERE e.user_id = $1 AND e.done_at IS NOT NULL AND date(e.done_at) = t.day) AS done,
       (SELECT count(*)::int FROM entries e
         WHERE e.user_id = $1 AND e.fired_at IS NOT NULL
           AND date(e.fired_at) = t.day AND e.remind_at <= e.fired_at) AS missed
     FROM d t ORDER BY t.day ASC`,
    [userId],
  );

  const days = daily.slice(-7).map((r) => ({
    day: r.day, due: r.due, done: r.done, missed: r.missed,
  }));
  const todayRow = daily[daily.length - 1] ?? { day: '', due: 0, done: 0, missed: 0 };
  const due = days.reduce((n, d) => n + d.due, 0);
  const onTime = days.reduce((n, d) => n + Math.max(0, d.due - d.missed), 0);

  // 今天还没到就算到昨天为止；中间有一天有漏就断
  let streakDays = 0;
  const start = todayRow.due === 0 ? daily.length - 2 : daily.length - 1;
  for (let i = start; i >= 0; i--) {
    if (daily[i].due > 0 && daily[i].missed === 0) streakDays++;
    else break;
  }

  const dismissed = await one<{ n: number }>(
    'SELECT count(*)::int AS n FROM dismissals WHERE user_id = $1', [userId],
  );

  return {
    streakDays,
    today: { due: todayRow.due, done: todayRow.done, missed: todayRow.missed },
    week: { due, onTime, rate: due > 0 ? onTime / due : 0 },
    dismissed: dismissed?.n ?? 0,
    days,
  };
}
