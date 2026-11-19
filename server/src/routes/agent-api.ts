/**
 * Agent 专用 API。和 /api/v1 的用户接口完全分开：
 * - 只认 Agent 令牌（requireAgent），登录 token 一律 403
 * - 每个端点再按令牌的 read / write scope 校验
 * 所有操作都限定在令牌签发用户自己的数据里
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CreateEntryRequest, UpdateEntryRequest } from '../../../shared/types.js';
import { requireAgent } from '../auth.js';
import {
  ackEntry, createEntry, deleteEntry, getEntry, listEntries, updateEntry,
} from '../repo/entries.js';
import { listDevices } from '../repo/devices.js';
import { hub } from '../hub.js';

type Scope = 'read' | 'write';

function need(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.session!.scope === 'write') return;
    if (scope === 'read') return;
    await reply.code(403).send({
      error: 'SCOPE_DENIED', message: '这个 Agent 令牌是只读的，写操作需要签发 write 令牌',
    });
  };
}

export async function agentApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgent);

  app.get('/whoami', { preHandler: need('read') }, async (req) => ({
    user: req.session!.user,
    scope: req.session!.scope,
    device: req.session!.device,
  }));

  app.get('/entries', { preHandler: need('read') }, async (req) => {
    const q = req.query as { view?: string; limit?: string };
    const views = ['today', 'upcoming', 'inbox', 'all', 'done'] as const;
    const view = views.includes(q.view as never) ? (q.view as (typeof views)[number]) : 'all';
    return { entries: await listEntries(req.session!.user.id, view, q.limit ? Number(q.limit) : undefined) };
  });

  app.get('/entries/:id', { preHandler: need('read') }, async (req, reply) => {
    const e = await getEntry((req.params as { id: string }).id, req.session!.user.id);
    if (!e) return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    return { entry: e };
  });

  app.post('/entries', { preHandler: need('write') }, async (req, reply) => {
    const body = (req.body ?? {}) as CreateEntryRequest & { idempotencyKey?: string };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填' });
    }
    const userId = req.session!.user.id;
    const entry = await createEntry(userId, body, {
      source: 'mcp',
      idempotencyKey: body.idempotencyKey,
    });
    hub.broadcastToUser(userId, { t: 'entry.created', entry });
    return reply.code(201).send({ entry });
  });

  app.patch('/entries/:id', { preHandler: need('write') }, async (req, reply) => {
    const userId = req.session!.user.id;
    try {
      const entry = await updateEntry((req.params as { id: string }).id, userId, req.body as UpdateEntryRequest);
      hub.broadcastToUser(userId, { t: 'entry.updated', entry });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  app.post('/entries/:id/done', { preHandler: need('write') }, async (req, reply) => {
    const userId = req.session!.user.id;
    try {
      const entry = await ackEntry((req.params as { id: string }).id, userId, 'done', 'agent');
      hub.broadcastToUser(userId, { t: 'entry.updated', entry });
      return { entry };
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '条目不存在' });
    }
  });

  app.delete('/entries/:id', { preHandler: need('write') }, async (req) => {
    const id = (req.params as { id: string }).id;
    const userId = req.session!.user.id;
    await deleteEntry(id, userId);
    hub.broadcastToUser(userId, { t: 'entry.deleted', entryId: id });
    return { ok: true };
  });

  app.get('/devices', { preHandler: need('read') }, async (req) => ({
    devices: await listDevices(req.session!.user.id),
  }));
}
