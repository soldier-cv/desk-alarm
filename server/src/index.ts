import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { log } from './log.js';
import { hub } from './hub.js';
import { diagnose, ensureSchema, migrate, pool } from './db.js';
import { startScheduler, stopScheduler, schedulerStats } from './scheduler.js';
import { initTransports } from './transport/index.js';
import { requireAuth } from './auth.js';
import { deviceRoutes } from './routes/devices.js';
import { entryRoutes } from './routes/entries.js';
import { streamRoutes } from './routes/stream.js';
import { mcpRoutes } from './routes/mcp.js';

const app = Fastify({
  logger: false,
  bodyLimit: 256 * 1024,
});

/** 不是 JSON 的请求一律 400，不能落成 500，也不能悄悄当成空 body 放过去 */
function badJson(done: (err: Error | null, body?: unknown) => void) {
  const err = new Error('Body is not valid JSON') as Error & { statusCode: number };
  err.statusCode = 400;
  done(err, undefined);
}

/**
 * 容忍没有 body 的 POST。Fastify 默认对「声明了 json 但 body 为空」报 400，
 * 而 curl -X POST 不加 -d、PowerShell -Method Post 都是这种形态
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const s = typeof body === 'string' ? body.trim() : '';
  if (!s) return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch {
    badJson(done);
  }
});

// 有些客户端 POST 时压根不带 content-type。带了 body 就得能解析，
// 解析不了要报错，不能当成空对象吞掉
app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
  const s = typeof body === 'string' ? body.trim() : '';
  if (!s) return done(null, {});
  try {
    done(null, JSON.parse(s));
  } catch {
    badJson(done);
  }
});

// 请求体超出 bodyLimit 时给结构化错误，别让前端拿到空响应
app.setErrorHandler((err, _req, reply) => {
  const e = err as { statusCode?: number; message?: string };
  const status = e.statusCode ?? 500;
  if (status >= 500) log.error('request failed', err);
  return reply.code(status).send({
    error: status === 400 ? 'BAD_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL',
    message: status === 413 ? '请求体太大了' : status >= 500 ? '服务端出错了' : (e.message ?? '请求有问题'),
  });
});

await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

/* ------------------------------------------------------------ 健康检查 */

app.get('/healthz', async (_req, reply) => {
  const diag = await diagnose();
  if (!diag.ok) {
    return reply.code(503).send({ ok: false, db: false, reason: diag.reason, serverTs: Date.now() });
  }
  return {
    ok: true, db: true,
    schema: env.PGSCHEMA,
    connections: hub.connectionCount,
    serverTs: Date.now(),
  };
});

/* ---------------------------------------------------------------- API */

// 每组路由单独 register，形成独立封装作用域。
// entryRoutes 内部用了 app 级 preHandler，共用实例的话钩子会泄漏到 /auth/login
await app.register(
  async (api) => { await deviceRoutes(api); },
  { prefix: '/api/v1' },
);

await app.register(
  async (api) => { await entryRoutes(api); },
  { prefix: '/api/v1' },
);

await app.register(
  async (ws) => { await streamRoutes(ws); },
  { prefix: '/api/v1' },
);

/* --------------------------------------------------------------- MCP */
// agent 用的 HTTP 入口。stdio 版本在 mcp/stdio.ts，
// 它是个独立进程，走同样的这些接口
await app.register(
  async (api) => { await mcpRoutes(api); },
  { prefix: '/api/mcp' },
);

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  log.info('connecting db', {
    host: env.PGHOST, port: env.PGPORT, database: env.PGDATABASE, user: env.PGUSER,
  });

  const diag = await diagnose();
  if (!diag.ok) {
    log.error('连不上数据库', { 原因: diag.reason, 目标: diag.target });
    if (diag.hint) log.error('怎么修', diag.hint);
    process.exit(1);
  }

  const schema = await ensureSchema();
  if (!schema.ok) {
    log.error('schema 不可用', { schema: env.PGSCHEMA, 目标: diag.target });
    log.error('怎么修', schema.hint);
    process.exit(1);
  }
  log.info('schema ok', { schema: env.PGSCHEMA });

  await migrate();
  log.info('tables ok');

  initTransports();
  startScheduler();

  await app.listen({ port: env.PORT, host: env.HOST });
  log.info('deskalarm api listening', {
    url: `http://${env.HOST}:${env.PORT}`,
    passcode: env.PASSCODE === 'deskalarm' ? '(默认，生产必须改)' : '(已自定义)',
    fcm: env.FCM_PROJECT_ID ? 'on' : 'off',
  });
}

const shutdown = async (sig: string) => {
  log.info('shutting down', { signal: sig });
  stopScheduler();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void boot().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
