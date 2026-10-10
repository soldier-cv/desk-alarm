import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Device, LoginRequest, LoginResponse } from '../../shared/types.js';
import { env, passcodeMatches, token as newToken } from './env.js';
import { now, one, run } from './db.js';
import { getDevice, touch, upsertDevice } from './repo/devices.js';
import { invalidateTransport, setPushToken } from './repo/deliveries.js';

interface SessionRow {
  token: string;
  device_id: string;
  expires_at: Date;
}

export async function login(req: LoginRequest): Promise<LoginResponse | { error: string }> {
  if (!passcodeMatches(req.passcode)) {
    return { error: 'BAD_PASSCODE' };
  }
  const device = await upsertDevice({
    id: req.deviceId,
    name: req.deviceName || '未命名设备',
    platform: req.platform,
    transport: req.transport,
    pushToken: req.pushToken ?? null,
  });
  const tok = newToken();
  const expires = new Date(Date.now() + env.SESSION_TTL_MS);
  await run(
    `INSERT INTO sessions (token, device_id, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (token) DO UPDATE SET device_id = excluded.device_id, expires_at = excluded.expires_at`,
    [tok, device.id, expires],
  );
  await touch(device.id);
  return { token: tok, device };
}

export async function logout(tok: string) {
  await run('DELETE FROM sessions WHERE token = $1', [tok]);
}

export async function resolveSession(req: FastifyRequest): Promise<{ token: string; device: Device } | null> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const q = (req.query as { token?: string } | undefined)?.token;
  const tok = bearer ?? q;
  if (!tok) return null;

  // MCP 可以用独立 token，不跟人抢会话
  if (env.MCP_TOKEN && tok === env.MCP_TOKEN) {
    // 优先用标记为本机的设备，没有就退回最早登录的那台。
    // 少了这个兜底，部署完 MCP 直接不可用
    const d = await one<{ id: string }>(
      `SELECT id FROM devices
        ORDER BY is_self DESC, created_at ASC LIMIT 1`,
    );
    if (!d) return null;
    const device = await getDevice(d.id);
    return device ? { token: tok, device } : null;
  }

  const row = await one<SessionRow>('SELECT * FROM sessions WHERE token = $1', [tok]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < now()) {
    await run('DELETE FROM sessions WHERE token = $1', [tok]);
    return null;
  }
  const device = await getDevice(row.device_id);
  if (!device) return null;
  return { token: tok, device };
}

declare module 'fastify' {
  interface FastifyRequest {
    session: { token: string; device: Device } | null;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const s = await resolveSession(req);
  req.session = s;
  if (!s) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
  }
}

export { setPushToken, invalidateTransport };
export { touch };
