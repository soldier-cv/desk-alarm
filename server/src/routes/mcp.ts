import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { log } from '../log.js';
import { TOOLS, callTool, type McpCtx } from '../mcp/tools.js';

/**
 * MCP 的 HTTP 入口。stdio 版本（mcp/stdio.ts）走的是同一批工具，
 * 它是个独立进程，通过这里的接口访问。
 *
 * 鉴权复用登录会话，也可以配独立的 MCP_TOKEN。
 * 建议给 agent 单独发一个 token，出问题能单独吊销
 */
export async function mcpRoutes(app: FastifyInstance) {
  // MCP 单独一层鉴权。独立 register，钩子不会泄漏到别处
  app.addHook('preHandler', requireAuth);

  /** 工具清单。stdio 和 HTTP 两个入口都从这里取，避免两份定义漂移 */
  app.get('/tools', async () => ({
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'deskalarm', version: '0.1.0' },
    tools: TOOLS,
  }));

  app.post('/call', async (req, reply) => {
    const body = req.body as { name?: string; arguments?: Record<string, unknown> };
    if (!body?.name) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'name 必填' });
    }

    const ctx: McpCtx = { source: 'mcp', deviceName: `${req.session!.device.name} (agent)` };

    try {
      const result = await callTool(body.name, body.arguments ?? {}, ctx);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 参数写错是 agent 的问题，不是服务端的错，400 比 500 诚实
      const isUsage = /必须|不能|未找到|找不到|未知|过期|最多|为空/.test(message);
      log.info('mcp call failed', { tool: body.name, message, isUsage });
      return reply.code(isUsage ? 400 : 500).send({ error: 'TOOL_FAILED', message });
    }
  });
}
