import type { FollowupRequest, FocusResult, Importance, Pursuit } from '../../shared/types.js';
import { now, toDt, tx } from './db.js';
import { hub } from './hub.js';
import { log } from './log.js';
import {
  focusReason, inQuietHours, levelFor, nextOccurrence, stalenessOf, suggestNextStep, weightOf,
} from './policy.js';
import { countStrongToday, createNudge, markDelivered } from './repo/nudges.js';
import { insertFollowup } from './repo/followups.js';
import {
  getPursuit, listActiveUserIds, listPursuits, setDueAt, setImportance, setStatus,
} from './repo/pursuits.js';
import { getSettings } from './repo/settings.js';
import { insertSteps } from './repo/steps.js';

const DAY = 24 * 60 * 60 * 1000;

export const engineStats = { active: 0, stalled: 0 };

function dayKey(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function channelFor(level: number): 'in_app' | 'notification' | 'takeover' {
  if (level === 1 || level === 3) return 'in_app';
  if (level === 2) return 'notification';
  return 'takeover';
}

export async function buildFocus(userId: string): Promise<FocusResult> {
  const serverTs = now();
  const settings = await getSettings(userId);
  const items = (await listPursuits(userId, { status: 'active' }))
    .map((p) => ({ p, w: weightOf(p, serverTs) }))
    .sort((a, b) => b.w - a.w
      || a.p.importanceSort - b.p.importanceSort
      || a.p.createdAt - b.p.createdAt)
    .slice(0, 5)
    .map(({ p }) => {
      const level = levelFor(stalenessOf(p.lastActivityAt, serverTs), settings);
      const reason = level === 5 ? '要么今天定个时间，要么归档' : focusReason(p);
      return {
        pursuit: p,
        reason,
        suggestedNextStep: level === 5 ? '要么今天定个时间，要么归档' : suggestNextStep(p),
      };
    });
  const budgetLeft = Math.max(0, settings.dailyStrongBudget - await countStrongToday(userId));
  return { serverTs, items, budgetLeft };
}

export async function pushFocus(userId: string): Promise<FocusResult> {
  const focus = await buildFocus(userId);
  const key = `1-${dayKey(focus.serverTs)}`;
  for (const item of focus.items) {
    const nudge = await createNudge(
      userId, item.pursuit.id, null, 1, 'in_app', item.reason, key,
    );
    if (!nudge) continue;
    hub.broadcastToUser(userId, {
      t: 'pursuit.nudge',
      pursuit: item.pursuit,
      level: 1,
      channel: 'in_app',
      reason: item.reason,
      serverTs: focus.serverTs,
    });
    await markDelivered(nudge.id);
  }
  hub.broadcastToUser(userId, {
    t: 'pursuit.focused', items: focus.items, budgetLeft: focus.budgetLeft,
  });
  return focus;
}

async function driveUser(userId: string, nowMs: number): Promise<{ active: number; stalled: number }> {
  const settings = await getSettings(userId);
  const pursuits = await listPursuits(userId, { status: 'active' });
  let strongLeft = Math.max(0, settings.dailyStrongBudget - await countStrongToday(userId));
  let stalled = 0;
  const key = dayKey(nowMs);

  for (const p of pursuits) {
    const staleness = stalenessOf(p.lastActivityAt, nowMs);
    if (staleness >= settings.escalateAfterMs.l3) stalled++;

    if (p.nature === 'recurring' && p.dueAt !== null && p.dueAt <= nowMs && p.recurrence) {
      const next = nextOccurrence(Math.max(p.dueAt, nowMs), p.recurrence);
      if (next !== null) {
        await setDueAt(p.id, userId, next);
        continue;
      }
    }

    let level = levelFor(staleness, settings);

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

    if (level === 4) {
      if (inQuietHours(settings, nowMs)) level = 2;
      else if (strongLeft <= 0) level = 3;
    }
    if (level === 5) {
      await setStatus(p.id, userId, 'archived');
      continue;
    }

    const deviceId = p.deviceIds.find((id) => hub.isOnline(id)) ?? null;
    const reason = focusReason(p);
    const created = await createNudge(
      userId, p.id, deviceId, level, channelFor(level), reason, `${level}-${key}`,
    );
    if (created && level >= 4) strongLeft--;
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
  const settings = await getSettings(userId);
  const level = levelFor(stalenessOf(p.lastActivityAt, nowMs), settings);

  const requested = typeof req.to === 'number' ? req.to : req.to ? Date.parse(req.to) : Number.NaN;
  let dueAt = toDt(p.dueAt);
  let status = p.status;
  let completedAt = toDt(p.completedAt);
  let extraSteps: string[] = [];

  switch (req.action) {
    case 'done':
      status = 'done';
      completedAt = new Date(nowMs);
      break;
    case 'archive':
      status = 'archived';
      break;
    case 'later': {
      const fallback = p.recurrence
        ? nextOccurrence(Math.max(p.dueAt ?? nowMs, nowMs), p.recurrence)
        : nowMs + DAY;
      dueAt = new Date(Number.isFinite(requested) ? requested : (fallback ?? nowMs + DAY));
      break;
    }
    case 'smaller':
      extraSteps = req.steps ?? [];
      break;
    default:
      break;
  }

  await tx(async (q) => {
    const cur = await q.one<{ version: number }>(
      'SELECT version FROM pursuits WHERE id = $1 AND user_id = $2', [pursuitId, userId],
    );
    if (!cur) throw new Error('NOT_FOUND');
    if (cur.version !== req.version) throw new Error('VERSION_CONFLICT');

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
  await tx(async (q) => {
    const cur = await q.one<{ id: string }>(
      'SELECT id FROM pursuits WHERE id = $1 AND user_id = $2', [pursuitId, userId],
    );
    if (!cur) throw new Error('NOT_FOUND');
    await insertSteps(q, pursuitId, userId, texts);
    await q.run(
      `UPDATE pursuits SET last_activity_at = now(), updated_at = now(), version = version + 1
        WHERE id = $1 AND user_id = $2`,
      [pursuitId, userId],
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
