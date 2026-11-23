import type { MyStats, NudgeLevel, Overview, PursuitNature, PursuitStatus } from '../../../shared/types.js';
import { one, rows } from '../db.js';
import { schedulerStats } from '../scheduler.js';

const STATUSES: PursuitStatus[] = ['inbox', 'active', 'paused', 'done', 'archived'];
const LEVELS: NudgeLevel[] = [1, 2, 3, 4, 5];
const NATURES: PursuitNature[] = ['one_off', 'recurring', 'project'];

export async function getOverview(): Promise<Overview> {
  const statusRows = await rows<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM pursuits GROUP BY status',
  );
  const pursuits: Record<PursuitStatus, number> = { inbox: 0, active: 0, paused: 0, done: 0, archived: 0 };
  for (const r of statusRows) if (STATUSES.includes(r.status as PursuitStatus)) {
    pursuits[r.status as PursuitStatus] = r.n;
  }

  const levelRows = await rows<{ level: number; n: number }>(
    `SELECT level, count(*)::int AS n FROM nudges
      WHERE at >= date_trunc('day', now()) GROUP BY level`,
  );
  const nudgesToday: Record<NudgeLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of levelRows) if (LEVELS.includes(r.level as NudgeLevel)) {
    nudgesToday[r.level as NudgeLevel] = r.n;
  }

  const deviceRow = await one<{ total: number; online: number }>(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE online)::int AS online FROM devices',
  );
  const byPlatform: Record<string, number> = {};
  for (const r of await rows<{ platform: string; n: number }>(
    'SELECT platform, count(*)::int AS n FROM devices GROUP BY platform',
  )) byPlatform[r.platform] = r.n;

  const userRow = await one<{ total: number }>('SELECT count(*)::int AS total FROM users');
  // A 模块的新 schedulerStats 才带 active/stalled；兼容过渡期缺口
  const sched = schedulerStats() as ReturnType<typeof schedulerStats> & {
    active?: number; stalled?: number;
  };

  return {
    serverTs: Date.now(),
    uptimeMs: Math.round(process.uptime() * 1000),
    db: { ok: true },
    engine: {
      tickMs: sched.tickMs,
      ticks: sched.ticks,
      lastTickAt: sched.lastTickAt,
      active: sched.active ?? 0,
      stalled: sched.stalled ?? 0,
    },
    pursuits,
    nudgesToday,
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
 * focus 按当天 nudges 数（被推进触达的次数），done 按完成时刻，pending 按未投递的 nudge。
 */
export async function getMyStats(userId: string): Promise<MyStats> {
  const daily = await rows<{ day: string; focus: number; done: number; pending: number }>(
    `WITH d AS (
       SELECT generate_series((now()::date - interval '59 days')::date,
                              now()::date, interval '1 day')::date AS day
     )
     SELECT t.day::text AS day,
       (SELECT count(*)::int FROM nudges n
          WHERE n.user_id = $1 AND date(n.at) = t.day) AS focus,
       (SELECT count(*)::int FROM pursuits p
          WHERE p.user_id = $1 AND p.completed_at IS NOT NULL
            AND date(p.completed_at) = t.day) AS done,
       (SELECT count(*)::int FROM nudges n
          WHERE n.user_id = $1 AND date(n.at) = t.day
            AND n.state = 'pending') AS pending
     FROM d t ORDER BY t.day ASC`,
    [userId],
  );

  const days = daily.slice(-7).map((r) => ({ day: r.day, focus: r.focus, done: r.done, pending: r.pending }));
  const today = daily[daily.length - 1] ?? { day: '', focus: 0, done: 0, pending: 0 };

  // 今天还没结束时不算断：从前一天起算连续天数
  let streakDays = 0;
  const start = today.done === 0 ? daily.length - 2 : daily.length - 1;
  for (let i = start; i >= 0; i--) {
    if (daily[i].done > 0) streakDays++;
    else break;
  }

  const weekRow = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM pursuits
      WHERE user_id = $1 AND completed_at >= date_trunc('week', now())`,
    [userId],
  );

  const byNature: Record<PursuitNature, number> = { one_off: 0, recurring: 0, project: 0 };
  for (const r of await rows<{ nature: string; n: number }>(
    'SELECT nature, count(*)::int AS n FROM pursuits WHERE user_id = $1 GROUP BY nature',
    [userId],
  )) if (NATURES.includes(r.nature as PursuitNature)) byNature[r.nature as PursuitNature] = r.n;

  return {
    serverTs: Date.now(),
    completedThisWeek: weekRow?.n ?? 0,
    streakDays,
    today: { focus: today.focus, done: today.done, pendingFollowup: today.pending },
    days,
    byNature,
  };
}
