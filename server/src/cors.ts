import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

/**
 * 桌面客户端的页面源是 http://tauri.localhost，和服务端地址天然不同源，
 * 浏览器会按 CORS 拦掉所有请求（表现为「连不上」，跟 CSP 无关）。
 * 砍掉 nginx 网关后没人补这几个头，所以只能在服务端发。
 */
const APP_ORIGINS = [
  // Windows 生产包
  'http://tauri.localhost',
  'https://tauri.localhost',
  // Linux/macOS 的 custom scheme
  'tauri://localhost',
  // vite dev
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function corsOrigins(): string[] {
  const extra = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return [...APP_ORIGINS, ...extra];
}

/**
 * OPTIONS 预检没有对应路由，交给 Fastify 会直接 404，
 * 所以必须在路由前拦下来自己回。
 */
export function allowAppOrigins(app: FastifyInstance) {
  const allowed = new Set(corsOrigins());

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;

    // 每个源单独回显，不能用 *：带 Authorization 的请求不允许通配
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('access-control-allow-headers', 'authorization,content-type');

    if (req.method === 'OPTIONS') {
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });
}
