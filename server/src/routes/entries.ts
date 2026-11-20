import type { FastifyInstance } from 'fastify';
import type {
  CreateEntryRequest, DismissRequest, SnoozeRequest, UpdateEntryRequest,
} from '../../../shared/types.js';
import { requireHuman } from '../auth.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import {
  VersionConflict, ackEntry, createEntry, deleteEntry, dismissEntry, getEntry,
  getEntryCounts, listDismissals, listEntries, listNeglected, reopenEntry, searchEntries, updateEntry,
} from '../repo/entries.js';
import { findMissed, markAcked } from '../repo/deliveries.js';
import { getSettings, patchSettings } from '../repo/settings.js';

export async function entryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);

  const uid = (req: { session: { user: { id: string } } | null }) => req.session!.user.id;
  const actor = (req: { session: { device: { id: string; name: string } | null; user: { username: string } } | null }) => ({
    id: req.session!.device?.id ?? 'web',
    name: req.session!.device?.name ?? req.session!.user.username,
  });

  const ENUMS: Record<string, string[]> = {
    kind: ['text', 'link', 'path'],
    repeat: ['none', 'daily', 'weekly', 'monthly'],
    strength: ['weak', 'strong'],
  };
  const badFields = (body: Record<string, unknown>) => {
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (body[key] !== undefined && !allowed.includes(String(body[key]))) return `${key} 取值不合法`;
    }
    if (body.bypassQuiet !== undefined && typeof body.bypassQuiet !== 'boolean') return 'bypassQuiet 必须是布尔值';
    if (body.devices !== undefined && !Array.isArray(body.devices)) return 'devices 必须是数组';
    return null;
  };

  app.get('/entries', async (req) => {
    const userId = uid(req);
    const q = req.query as { view?: string; limit?: string; q?: string };
    if (q.q) return { entries: await searchEntries(userId, q.q) };

    if (q.view === 'dismissed') {
      return {
        dismissals: await listDismissals(userId, q.limit ? Number(q.limit) : undefined),
        entries: [],
      };
    }
    const views = ['today', 'upcoming', 'inbox', 'all', 'done'] as const;
    const view = views.includes(q.view as never) ? (q.view as (typeof views)[number]) : 'all';
    return { entries: await listEntries(userId, view, q.limit ? Number(q.limit) : undefined) };
  });

  app.get('/entries/counts', async (req) => ({ counts: await getEntryCounts(uid(req)) }));

  app.get('/entries/:id', async (req, reply) => {
    const e = await getEntry((req.params as { id: string }).id, uid(req));
    if (!e) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    return { entry: e };
  });

  app.get('/neglected', async (req) => {
    const userId = uid(req);
    const settings = await getSettings(userId);
    return { entries: await listNeglected(userId, settings.neglectedAfter) };
  });

  app.post('/entries', async (req, reply) => {
    const body = (req.body ?? {}) as CreateEntryRequest & { idempotencyKey?: string };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填，而且不能是空字符串' });
    }
    if (body.text.length > 4000) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 太长了，控制在 4000 字以内' });
    }
    if (body.strength && body.strength !== 'weak' && body.strength !== 'strong') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'strength 只能是 weak 或 strong' });
    }
    const bad = badFields(body as unknown as Record<string, unknown>);
    if (bad) return reply.code(400).send({ error: 'BAD_REQUEST', message: bad });

    const userId = uid(req);
    const entry = await createEntry(userId, body, {
      source: body.idempotencyKey?.startsWith('mcp:') ? 'mcp' : 'app',
      idempotencyKey: body.idempotencyKey,
    });
    hub.broadcastToUser(userId, { t: 'entry.created', entry });
    log.info('entry created', {
      id: entry.id, kind: entry.kind, strength: entry.strength,
      remindAt: entry.remindAt, source: entry.source,
    });
    return reply.code(201).send({ entry });
  });

  app.patch('/entries/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const bad = badFields(req.body as Record<string, unknown>);
    if (bad) return reply.code(400).send({ error: 'BAD_REQUEST', message: bad });
    const cur = await getEntry(id, userId);
    if (cur?.doneAt !== undefined && cur?.doneAt !== null) {
      return reply.code(409).send({
        error: 'DONE_READONLY', message: '已完成的条目不能修改，可以复制成新条目',
      });
    }
    try {
      const entry = await updateEntry(id, userId, req.body as UpdateEntryRequest);
      hub.broadcastToUser(userId, { t: 'entry.updated', entry });
      return { entry };
    } catch (err) {
      if (err instanceof VersionConflict) {
        return reply.code(409).send({
          error: 'VERSION_CONFLICT', message: err.message, current: err.current,
        });
      }
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
      }
      log.error('entry update failed', err);
      return reply.code(500).send({ error: 'INTERNAL', message: '保存失败，请重试' });
    }
  });

  app.delete('/entries/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    await deleteEntry(id, userId);
    hub.broadcastToUser(userId, { t: 'entry.deleted', entryId: id });
    return { ok: true };
  });

  app.post('/entries/:id/done', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const who = actor(req);
    try {
      const entry = await ackEntry(id, userId, 'done', who.name);
      await markAcked(id, who.id, 'done');
      hub.broadcastToUser(userId, { t: 'entry.updated', entry });
      hub.broadcastToUser(userId, {
        t: 'entry.acked', entryId: id,
        deviceId: who.id, deviceName: who.name, action: 'done',
      });
      log.info('entry done', { id, by: who.name });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  app.post('/entries/:id/snooze', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const who = actor(req);
    const body = (req.body ?? {}) as SnoozeRequest;

    let target: number | null = null;
    if (typeof body.to === 'number' || typeof body.to === 'string') {
      const t = typeof body.to === 'number' ? body.to : Date.parse(body.to);
      if (!Number.isNaN(t)) target = t;
    } else if (typeof body.minutes === 'number') {
      const cur = await getEntry(id, userId);
      const base = Math.max(cur?.remindAt ?? 0, Date.now());
      target = base + body.minutes * 60_000;
    }
    if (target === null) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'minutes 或 to 必填一个' });
    }

    try {
      const entry = await ackEntry(id, userId, 'snooze', who.name, target);
      await markAcked(id, who.id, 'snooze');
      hub.broadcastToUser(userId, { t: 'entry.updated', entry });
      hub.broadcastToUser(userId, {
        t: 'entry.acked', entryId: id,
        deviceId: who.id, deviceName: who.name, action: 'snooze',
      });
      log.info('entry snoozed', { id, to: new Date(target).toISOString() });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  app.post('/entries/:id/dismiss', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const who = actor(req);
    const body = (req.body ?? {}) as DismissRequest;
    try {
      const r = await dismissEntry(id, userId, who.id, who.name, body.reason);
      await markAcked(id, who.id, 'dismiss');
      hub.broadcastToUser(userId, { t: 'entry.updated', entry: r.entry });
      hub.broadcastToUser(userId, {
        t: 'entry.acked', entryId: id,
        deviceId: who.id, deviceName: who.name, action: 'dismiss',
      });
      if (r.suggestion && r.entry.strength === 'weak') {
        hub.broadcastToUser(userId, {
          t: 'entry.downgraded', entry: r.entry,
          dismissCount: r.dismissCount, reason: r.suggestion,
        });
      }
      log.info('entry dismissed', {
        id, by: who.name, count: r.dismissCount, reason: body.reason ?? '(没写)',
      });
      return { ...r };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  app.post('/entries/:id/rearm', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = uid(req);
    const cur = await getEntry(id, userId);
    if (!cur) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    const next = cur.remindAt && cur.remindAt > Date.now() ? cur.remindAt : Date.now() + 60_000;
    const entry = await reopenEntry(id, userId, next, cur.version);
    hub.broadcastToUser(userId, { t: 'entry.updated', entry });
    return { entry };
  });

  app.get('/missed', async (req) => {
    const userId = uid(req);
    const deviceId = req.session!.device?.id;
    return { missed: deviceId ? await findMissed(userId, deviceId) : [] };
  });

  app.get('/settings', async (req) => ({ settings: await getSettings(uid(req)) }));

  app.patch('/settings', async (req) => {
    const userId = uid(req);
    const settings = await patchSettings(userId, req.body as Record<string, never>);
    hub.broadcastToUser(userId, { t: 'settings.changed', settings });
    return { settings };
  });
}
