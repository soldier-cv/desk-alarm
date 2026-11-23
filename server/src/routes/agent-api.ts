/**
 * Agent 专用 API（v2 推进引擎）。和 /api/v1 的用户接口完全分开：
 * - 只认 Agent 令牌（requireAgent），登录 token 一律 403
 * - 每个端点再按令牌的 read / write scope 校验
 * 所有操作都限定在令牌签发用户自己的数据里，域逻辑全部调 drive.ts / repo
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreatePursuitRequest, FocusResult, FollowupAction, FollowupRequest,
  Pursuit, PursuitStatus, UpdatePursuitRequest,
} from '../../../shared/types.js';
import { requireAgent } from '../auth.js';
import { buildFocus, decompose, followUp } from '../drive.js';
import {
  createPursuit, deletePursuit, getPursuit, listPursuits, updatePursuit,
} from '../repo/pursuits.js';
import { hub } from '../hub.js';

type Scope = 'read' | 'write';
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const STATUSES: readonly string[] = ['inbox', 'active', 'paused', 'done', 'archived'];
const FOLLOWUP_ACTIONS: readonly string[] = ['done', 'partial', 'later', 'smaller', 'archive', 'ignored'];

function need(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.session!.scope ?? 'read') === 'write') return;
    if (scope === 'read') return;
    await reply.code(403).send({
      error: 'SCOPE_DENIED', message: '这个 Agent 令牌是只读的，写操作需要签发 write 令牌',
    });
  };
}

function writeError(reply: FastifyReply, e: unknown) {
  const current = (e as { current?: Pursuit }).current;
  if (current) {
    return reply.code(409).send({
      error: 'VERSION_CONFLICT', message: '推进项已被其它设备修改', current,
    });
  }
  const message = msg(e);
  if (/VERSION_CONFLICT|已被其它设备修改/.test(message)) {
    return reply.code(409).send({ error: 'VERSION_CONFLICT', message: '推进项已被其它设备修改' });
  }
  if (/找不到|不存在|NOT_FOUND/.test(message)) {
    return reply.code(404).send({ error: 'NOT_FOUND', message });
  }
  throw e;
}

function asMs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function needsReason(req: CreatePursuitRequest): boolean {
  if ((req.importance ?? 0) >= 3) return true;
  if (req.commitment?.date != null) {
    const d = asMs(req.commitment.date);
    if (d !== null && d - Date.now() <= 24 * 3600_000) return true;
  }
  const due = asMs(req.dueAt);
  if (req.energy === 'high' && due !== null && due - Date.now() <= 24 * 3600_000) return true;
  return false;
}

export async function agentApiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAgent);

  app.get('/whoami', { preHandler: need('read') }, async (req) => ({
    user: req.session!.user,
    scope: req.session!.scope ?? 'read',
    device: req.session!.device,
  }));

  app.get('/focus', { preHandler: need('read') }, async (req): Promise<FocusResult> =>
    buildFocus(req.session!.user.id));

  app.get('/pursuits', { preHandler: need('read') }, async (req) => {
    const q = req.query as { status?: string };
    const status = q.status && STATUSES.includes(q.status) ? q.status as PursuitStatus : undefined;
    const pursuits = await listPursuits(req.session!.user.id, status ? { status } : undefined);
    return { pursuits };
  });

  app.get('/pursuits/:id', { preHandler: need('read') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const pursuit = await getPursuit(id, req.session!.user.id);
    if (!pursuit) return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    return { pursuit };
  });

  const create = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as CreatePursuitRequest & { reason?: string };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'text 必填' });
    }
    if (needsReason(body) && !(body.reason ?? '').trim()) {
      return reply.code(400).send({
        error: 'REASON_REQUIRED',
        message: 'importance>=3 或会很快升级到强打扰，必须给 reason 说明依据',
      });
    }
    const userId = req.session!.user.id;
    const pursuit = await createPursuit(userId, body);
    hub.broadcastToUser(userId, { t: 'pursuit.created', pursuit });
    return reply.code(201).send({ pursuit });
  };
  app.post('/pursuits', { preHandler: need('write') }, create);

  const update = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const userId = req.session!.user.id;
    const body = (req.body ?? {}) as UpdatePursuitRequest;
    if (!Number.isInteger(body.version)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'version 必填，先 GET /pursuits/:id 拿最新版本号' });
    }
    try {
      const pursuit = await updatePursuit(id, userId, body);
      if (!pursuit) {
        // 版本不匹配和记录不存在都返回 null，再查一次才能给出正确的状态码
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
    } catch (e) {
      return writeError(reply, e);
    }
  };
  app.patch('/pursuits/:id', { preHandler: need('write') }, update);

  const remove = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    const userId = req.session!.user.id;
    const ok = await deletePursuit(id, userId);
    if (!ok) return reply.code(404).send({ error: 'NOT_FOUND', message: '推进项不存在' });
    hub.broadcastToUser(userId, { t: 'pursuit.deleted', pursuitId: id });
    return { ok: true };
  };
  app.delete('/pursuits/:id', { preHandler: need('write') }, remove);

  const followup = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { id?: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(params.id ?? body.id ?? '');
    const action = String(body.action ?? '') as FollowupAction;
    if (!id) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'id 必填' });
    if (!FOLLOWUP_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: `未知的 action ${action}` });
    }
    if (!Number.isInteger(body.version)) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'version 必填，先 GET /pursuits/:id 拿最新版本号' });
    }
    const reqBody: FollowupRequest = { action, version: body.version as number };
    if (body.note !== undefined) reqBody.note = String(body.note);
    if (body.to !== undefined) reqBody.to = body.to as number | string;
    if (Array.isArray(body.steps)) reqBody.steps = body.steps.map((s) => String(s));

    const userId = req.session!.user.id;
    try {
      const pursuit = await followUp(id, userId, reqBody);
      hub.broadcastToUser(userId, { t: 'pursuit.followed', pursuit, action });
      return { pursuit };
    } catch (e) {
      return writeError(reply, e);
    }
  };
  app.post('/followup', { preHandler: need('write') }, followup);
  app.post('/pursuits/:id/followup', { preHandler: need('write') }, followup);

  const decomposeH = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { id?: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(params.id ?? body.id ?? '');
    if (!id) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'id 必填' });
    if (!Array.isArray(body.texts) || !body.texts.length) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'texts 必须是非空数组' });
    }
    const userId = req.session!.user.id;
    try {
      const pursuit = await decompose(id, userId, body.texts.map((t) => String(t)));
      hub.broadcastToUser(userId, { t: 'pursuit.stepped', pursuit });
      return { pursuit };
    } catch (e) {
      return writeError(reply, e);
    }
  };
  app.post('/decompose', { preHandler: need('write') }, decomposeH);
  app.post('/pursuits/:id/decompose', { preHandler: need('write') }, decomposeH);
}
