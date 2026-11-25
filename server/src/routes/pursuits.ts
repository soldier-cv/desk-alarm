import type { FastifyInstance } from 'fastify';
import type {
  AddStepRequest, CreatePursuitRequest, FollowupRequest, Pursuit, PursuitStatus,
  Settings, UpdatePursuitRequest, UpdateStepRequest,
} from '../../../shared/types.js';
import { FOLLOWUP_ACTIONS } from '../../../shared/types.js';
import { requireHuman } from '../auth.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { buildFocus, followUp } from '../drive.js';
import { listMissed } from '../repo/nudges.js';
import {
  clonePursuit, createPursuit, deletePursuit, getPursuit, listPursuits, updatePursuit,
} from '../repo/pursuits.js';
import { addStep, updateStep } from '../repo/steps.js';
import { getSettings, saveSettings } from '../repo/settings.js';

const KINDS = ['text', 'link', 'path', 'image', 'audio'] as const;
const NATURES = ['one_off', 'project'] as const;
const STATUSES = ['inbox', 'active', 'paused', 'done', 'archived'] as const;
const STEP_STATES = ['todo', 'doing', 'done'] as const;
const FREQS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;

function oneOf<T extends string>(allowed: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

function validRecurrence(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as {
    freq?: unknown; byWeekday?: unknown; byMonthday?: unknown; byMonth?: unknown;
  };
  if (!oneOf(FREQS, r.freq)) return false;
  if (r.byWeekday !== undefined && r.freq !== 'weekly') return false;
  if (r.byMonthday !== undefined && !['monthly', 'quarterly', 'yearly'].includes(r.freq)) return false;
  if (r.byMonth !== undefined && r.freq !== 'yearly') return false;
  if (r.byWeekday !== undefined && (
    !Array.isArray(r.byWeekday) || r.byWeekday.length > 7 ||
    !r.byWeekday.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  )) return false;
  const byMonthday = r.byMonthday;
  if (byMonthday !== undefined && (
    typeof byMonthday !== 'number' || !Number.isInteger(byMonthday) || byMonthday < 1 || byMonthday > 31
  )) return false;
  const byMonth = r.byMonth;
  if (byMonth !== undefined && (
    typeof byMonth !== 'number' || !Number.isInteger(byMonth) || byMonth < 1 || byMonth > 12
  )) return false;
  return true;
}

function isVersionConflict(err: unknown): err is Error & { current?: Pursuit } {
  return err instanceof Error && (err.name === 'VersionConflict' ||
    err.message === 'VERSION_CONFLICT' ||
    (err as { statusCode?: number }).statusCode === 409);
}

export async function pursuitRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);

  const uid = (req: { session: { user: { id: string } } | null }) => req.session!.user.id;

  app.get('/pursuits', async (req, reply) => {
    const q = req.query as { status?: string };
    if (q.status !== undefined && !oneOf(STATUSES, q.status)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'status 取值不合法' });
    }
    return { pursuits: await listPursuits(uid(req), q.status ? { status: q.status as PursuitStatus } : undefined) };
  });

  app.get('/pursuits/:id', async (req, reply) => {
    const p = await getPursuit((req.params as { id: string }).id, uid(req));
    if (!p) return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    return { pursuit: p };
  });

  app.post('/pursuits', async (req, reply) => {
    const body = (req.body ?? {}) as CreatePursuitRequest;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填，而且不能是空字符串' });
    }
    if (body.text.length > 4000) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 太长了，控制在 4000 字以内' });
    }
    if (body.kind !== undefined && !oneOf(KINDS, body.kind)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'kind 取值不合法' });
    }
    if (body.nature !== undefined && !oneOf(NATURES, body.nature)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'nature 取值不合法' });
    }
    if (body.strength !== undefined && !['strong', 'weak'].includes(body.strength)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'strength 只能是 strong 或 weak' });
    }
    if (body.importance !== undefined && ![0, 1, 2, 3].includes(body.importance)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'importance 只能是 0..3' });
    }
    if (body.energy !== undefined && !oneOf(ENERGIES, body.energy)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'energy 取值不合法' });
    }
    if (body.status !== undefined && !oneOf(STATUSES, body.status)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'status 取值不合法' });
    }
    if (!validRecurrence(body.recurrence)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'recurrence 重复规则不合法' });
    }
    if (body.steps !== undefined && !Array.isArray(body.steps)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'steps 必须是数组' });
    }
    if (body.deviceIds !== undefined && !Array.isArray(body.deviceIds)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'deviceIds 必须是数组' });
    }

    const userId = uid(req);
    const pursuit = await createPursuit(userId, body);
    hub.broadcastToUser(userId, { t: 'pursuit.created', pursuit });
    log.info('pursuit created', { id: pursuit.id, nature: pursuit.nature, source: pursuit.source });
    return reply.code(201).send({ pursuit });
  });

  app.patch('/pursuits/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const body = (req.body ?? {}) as UpdatePursuitRequest;
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'version 必填' });
    }
    if (body.nature !== undefined && !oneOf(NATURES, body.nature)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'nature 取值不合法' });
    }
    if (body.strength !== undefined && !['strong', 'weak'].includes(body.strength)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'strength 只能是 strong 或 weak' });
    }
    if (body.importance !== undefined && ![0, 1, 2, 3].includes(body.importance)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'importance 只能是 0..3' });
    }
    if (body.energy !== undefined && !oneOf(ENERGIES, body.energy)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'energy 取值不合法' });
    }
    if (body.status !== undefined && !oneOf(STATUSES, body.status)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'status 取值不合法' });
    }
    if ('recurrence' in body && !validRecurrence(body.recurrence)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'recurrence 重复规则不合法' });
    }

    try {
      const pursuit = await updatePursuit(id, userId, body);
      if (!pursuit) {
        const current = await getPursuit(id, userId);
        if (current) {
          return reply.code(409).send({
            error: 'VERSION_CONFLICT', message: '推进项已被其它设备修改', current,
          });
        }
        return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
      }
      hub.broadcastToUser(userId, { t: 'pursuit.updated', pursuit });
      return { pursuit };
    } catch (err) {
      if (isVersionConflict(err)) {
        return reply.code(409).send({
          error: 'VERSION_CONFLICT', message: err.message, current: err.current,
        });
      }
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
      }
      log.error('pursuit update failed', err);
      return reply.code(500).send({ error: 'INTERNAL', message: '保存失败，请重试' });
    }
  });

  app.delete('/pursuits/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    if (!(await deletePursuit(id, userId))) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    }
    hub.broadcastToUser(userId, { t: 'pursuit.deleted', pursuitId: id });
    return { ok: true };
  });

  app.post('/pursuits/:id/steps', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const body = (req.body ?? {}) as AddStepRequest;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填' });
    }
    if (!(await getPursuit(id, userId))) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    }
    const step = await addStep(id, userId, body.text);
    const pursuit = await getPursuit(id, userId);
    if (pursuit) hub.broadcastToUser(userId, { t: 'pursuit.stepped', pursuit });
    return reply.code(201).send({ step, pursuit });
  });

  app.patch('/steps/:stepId', async (req, reply) => {
    const stepId = (req.params as { stepId: string }).stepId;
    const userId = uid(req);
    const body = (req.body ?? {}) as UpdateStepRequest;
    if (body.text === undefined && body.state === undefined) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 或 state 至少给一个' });
    }
    if (body.state !== undefined && !oneOf(STEP_STATES, body.state)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'state 取值不合法' });
    }
    const step = await updateStep(stepId, userId, body);
    if (!step) return reply.code(404).send({ error: 'NOT_FOUND', message: '步骤不存在' });
    const pursuit = await getPursuit(step.pursuitId, userId);
    if (pursuit) hub.broadcastToUser(userId, { t: 'pursuit.stepped', pursuit });
    return { step, pursuit };
  });

  app.post('/pursuits/:id/followup', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const body = (req.body ?? {}) as FollowupRequest;
    if (!FOLLOWUP_ACTIONS.includes(body.action as typeof FOLLOWUP_ACTIONS[number])) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'action 取值不合法' });
    }
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'version 必填' });
    }
    try {
      const pursuit = await followUp(id, userId, body);
      hub.broadcastToUser(userId, { t: 'pursuit.followed', pursuit, action: body.action });
      return { pursuit };
    } catch (err) {
      if (isVersionConflict(err)) {
        return reply.code(409).send({
          error: 'VERSION_CONFLICT', message: err.message, current: err.current,
        });
      }
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
      }
      if (err instanceof Error && err.message === 'ACTION_NOT_ALLOWED') {
        return reply.code(400).send({
          error: 'ACTION_NOT_ALLOWED', message: '当前状态不允许这个跟进动作',
        });
      }
      throw err;
    }
  });

  app.post('/pursuits/:id/clone', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const pursuit = await clonePursuit(id, userId);
    if (!pursuit) return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    hub.broadcastToUser(userId, { t: 'pursuit.created', pursuit });
    return reply.code(201).send({ pursuit });
  });

  app.get('/focus', async (req) => buildFocus(uid(req)));

  app.get('/settings', async (req) => ({ settings: await getSettings(uid(req)) }));

  app.patch('/settings', async (req) => {
    const userId = uid(req);
    const settings = await saveSettings(userId, (req.body ?? {}) as Partial<Settings>);
    hub.broadcastToUser(userId, { t: 'settings.changed', settings });
    return { settings };
  });

  app.get('/missed', async (req, reply) => {
    const q = req.query as { after?: string };
    const afterMs = q.after !== undefined ? Number(q.after) : Date.now();
    if (!Number.isFinite(afterMs)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'after 必须是毫秒时间戳' });
    }
    return { missed: await listMissed(uid(req), afterMs) };
  });
}
