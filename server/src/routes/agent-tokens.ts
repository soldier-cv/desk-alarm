import type { FastifyInstance } from 'fastify';
import { requireHuman } from '../auth.js';
import { log } from '../log.js';
import {
  createToken, listTokens, revokeToken, type AgentScope,
} from '../repo/agent-tokens.js';

export async function agentTokenRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);

  app.get('/agent-tokens', async (req) => ({
    tokens: await listTokens(req.session!.user.id),
  }));

  app.post('/agent-tokens', async (req, reply) => {
    const body = req.body as {
      name?: string; machineId?: string; scope?: AgentScope; days?: number;
    };
    const name = body.name?.trim() ?? '';
    // machineId 可空：云端 agent 没有机器，令牌只绑定签发用户
    const machineId = body.machineId?.trim() || null;
    if (!name) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'name 必填' });
    }
    const scope = body.scope ?? 'write';
    if (scope !== 'read' && scope !== 'write') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'scope 只能是 read 或 write' });
    }
    const days = Math.min(Math.max(Number(body.days ?? 365) || 365, 1), 3650);

    const { token, plain } = await createToken({
      userId: req.session!.user.id,
      name, machineId, scope, days,
    });
    log.info('agent token issued', { by: req.session!.user.username, name, scope });
    // 明文只在这里返回一次，之后只能看到 prefix
    return reply.code(201).send({ token, plain });
  });

  app.delete('/agent-tokens/:id', async (req, reply) => {
    const ok = await revokeToken((req.params as { id: string }).id, req.session!.user.id);
    if (!ok) return reply.code(404).send({ error: 'NOT_FOUND', message: '令牌不存在或已撤销' });
    log.info('agent token revoked', { by: req.session!.user.username });
    return { ok: true };
  });
}
