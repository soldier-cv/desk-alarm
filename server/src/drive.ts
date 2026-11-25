import {
  defaultDueMs, levelForStrength,
  type FollowupRequest, type FocusResult, type Importance, type Pursuit, type ReminderStrength,
} from '../../shared/types.js';
import { now, toDt, tx } from './db.js';
import { hub } from './hub.js';
import { log } from './log.js';
import { focusReason, inQuietHours, nextOccurrence, suggestNextStep } from './policy.js';
import { createNudge } from './repo/nudges.js';
import { insertFollowup } from './repo/followups.js';
import {
  getPursuit, listActiveUserIds, listPursuits, setDueAt, setImportance, setStatus,
} from './repo/pursuits.js';
import { getSettings } from './repo/settings.js';
import { insertSteps, markStepDone } from './repo/steps.js';

const DAY = 24 * 60 * 60 * 1000;

export const engineStats = { active: 0, stalled: 0 };

function byDue(a: Pursuit, b: Pursuit): number {
  if (a.dueAt === null) return b.dueAt === null ? 0 : 1;
  if (b.dueAt === null) return -1;
  return a.dueAt - b.dueAt
    || a.importanceSort - b.importanceSort
    || a.createdAt - b.createdAt;
}

function channelFor(strength: ReminderStrength): 'notification' | 'takeover' {
  return strength === 'strong' ? 'takeover' : 'notification';
}

/** 拆小/延期后的新节点：用户给的时间优先，否则按强弱默认值，已有更近的截止时间保留 */
function nextDue(p: Pursuit, strength: ReminderStrength, nowMs: number, requested: number): number {
  if (Number.isFinite(requested)) return requested;
  const fallback = defaultDueMs(strength, nowMs);
  return p.dueAt !== null && p.dueAt > nowMs ? Math.min(p.dueAt, fallback) : fallback;
}

export async function buildFocus(userId: string): Promise<FocusResult> {
  const serverTs = now();
  const items = (await listPursuits(userId, { status: 'active' }))
    .sort(byDue)
    .slice(0, 5)
    .map((p) => ({
      pursuit: p,
      reason: focusReason(p),
      suggestedNextStep: suggestNextStep(p),
    }));
  return { serverTs, items };
}

export async function pushFocus(userId: string): Promise<FocusResult> {
  const focus = await buildFocus(userId);
  hub.broadcastToUser(userId, { t: 'pursuit.focused', items: focus.items });
  return focus;
}

async function driveUser(userId: string, nowMs: number): Promise<{ active: number; stalled: number }> {
  const settings = await getSettings(userId);
  const pursuits = (await listPursuits(userId, { status: 'active' })).sort(byDue);
  let stalled = 0;
  const quiet = inQuietHours(settings, nowMs);

  for (const p of pursuits) {
    if (p.dueAt !== null && p.dueAt < nowMs) stalled++;

    if (p.context?.timeWindow) {
      const d = new Date(nowMs);
      const min = d.getHours() * 60 + d.getMinutes();
      const { startMin, endMin } = p.context.timeWindow;
      const hit = startMin <= endMin
        ? min >= startMin && min < endMin
        : min >= startMin || min < endMin;
      if (!hit) continue;
    }
    if (p.context?.device && !hub.isOnline(p.context.device)) continue;

    if (p.dueAt === null || p.dueAt > nowMs) continue;

    const strength = p.strength;
    const level = levelForStrength(strength);

    if (nowMs - p.dueAt >= settings.archiveAfterDays * DAY) {
      await tx(async (q) => {
        await insertFollowup(q, p.id, userId, level, 'archive', `截止已过 ${settings.archiveAfterDays} 天，自动归档`);
      });
      await setStatus(p.id, userId, 'archived');
      continue;
    }

    // 静音时段不投递也不推进周期，下一 tick（静音结束）按原截止时间补发
    if (quiet) continue;

    const deviceId = p.deviceIds.find((id) => hub.isOnline(id)) ?? null;
    const reason = strength === 'strong' ? '到点了，先处理这条' : '到点了，看一下';
    await createNudge(
      userId, p.id, deviceId, level, channelFor(strength), reason, `${strength}-due-${p.dueAt}`,
    );

    if (p.nature === 'recurring' && p.recurrence) {
      const next = nextOccurrence(Math.max(p.dueAt, nowMs), p.recurrence);
      if (next !== null) await setDueAt(p.id, userId, next);
    }
  }

  return { active: pursuits.length, stalled };
}

export async function driveTick(): Promise<void> {
  const nowMs = now();
  const userIds = await listActiveUserIds();
  const counts = await Promise.all(userIds.map(async (userId) => {
    try {
      return await driveUser(userId, nowMs);
    } catch (err) {
      log.error('driveTick user failed', err);
      return { active: 0, stalled: 0 };
    }
  }));
  engineStats.active = counts.reduce((n, c) => n + c.active, 0);
  engineStats.stalled = counts.reduce((n, c) => n + c.stalled, 0);
}

export async function followUp(
  pursuitId: string, userId: string, req: FollowupRequest,
): Promise<Pursuit> {
  const nowMs = now();
  const p = await getPursuit(pursuitId, userId);
  if (!p) throw new Error('NOT_FOUND');
  const strength = p.strength;
  const level = levelForStrength(strength);

  const requested = typeof req.to === 'number' ? req.to : req.to ? Date.parse(req.to) : Number.NaN;
  let dueAt = toDt(p.dueAt);
  let status: PursuitStatus = p.status;
  let completedAt = toDt(p.completedAt);
  let extraSteps: string[] = [];

  switch (req.action) {
    case 'done':
      if (req.stepId) {
        const remaining = p.steps.filter((s) => s.id !== req.stepId && s.state !== 'done');
        if (remaining.length > 0) dueAt = new Date(nextDue(p, strength, nowMs, requested));
        else {
          status = 'done';
          completedAt = new Date(nowMs);
        }
      } else {
        status = 'done';
        completedAt = new Date(nowMs);
      }
      break;
    case 'reopen':
      status = 'active';
      completedAt = null;
      break;
    case 'archive':
      status = 'archived';
      break;
    case 'later':
      dueAt = new Date(nextDue(p, strength, nowMs, requested));
      break;
    case 'smaller':
      extraSteps = req.steps ?? [];
      dueAt = new Date(nextDue(p, strength, nowMs, requested));
      break;
  }

  await tx(async (q) => {
    const cur = await q.one<{ version: number }>(
      'SELECT version FROM pursuits WHERE id = $1 AND user_id = $2', [pursuitId, userId],
    );
    if (!cur) throw new Error('NOT_FOUND');
    if (cur.version !== req.version) throw new Error('VERSION_CONFLICT');

    if (req.action === 'done' && req.stepId && status !== 'done') {
      await markStepDone(q, req.stepId, userId);
    }
    await insertFollowup(q, pursuitId, userId, level, req.action, req.note ?? null);
    const n = await q.run(
      `UPDATE pursuits
          SET status = $2, due_at = $3, completed_at = $4,
              last_activity_at = now(), updated_at = now(), version = version + 1
        WHERE id = $1 AND user_id = $5 AND version = $6`,
      [pursuitId, status, dueAt, completedAt, userId, req.version],
    );
    if (n === 0) throw new Error('VERSION_CONFLICT');
    if (extraSteps.length > 0) await insertSteps(q, pursuitId, userId, extraSteps);
  });

  return (await getPursuit(pursuitId, userId))!;
}

export async function decompose(
  pursuitId: string, userId: string, texts: string[],
): Promise<Pursuit> {
  const p = await getPursuit(pursuitId, userId);
  if (!p) throw new Error('NOT_FOUND');
  const dueAt = new Date(defaultDueMs(p.strength, now()));
  await tx(async (q) => {
    const cur = await q.one<{ id: string }>(
      'SELECT id FROM pursuits WHERE id = $1 AND user_id = $2', [pursuitId, userId],
    );
    if (!cur) throw new Error('NOT_FOUND');
    await insertSteps(q, pursuitId, userId, texts);
    await q.run(
      `UPDATE pursuits SET due_at = $3, last_activity_at = now(), updated_at = now(), version = version + 1
        WHERE id = $1 AND user_id = $2`,
      [pursuitId, userId, dueAt],
    );
  });
  return (await getPursuit(pursuitId, userId))!;
}

export async function reprioritize(
  pursuitId: string, userId: string, importance: Importance,
): Promise<Pursuit> {
  const p = await setImportance(pursuitId, userId, importance);
  if (!p) throw new Error('NOT_FOUND');
  return p;
}
