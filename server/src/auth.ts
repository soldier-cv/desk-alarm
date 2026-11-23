import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Device, LoginRequest, LoginResponse, Role, User } from '../../shared/types.js';
import { env, token as newToken } from './env.js';
import { now, run, one } from './db.js';
import { getByMachineId, getDevice, machineOwner, upsertDeviceByMachine } from './repo/devices.js';
import { getUser, getUserByUsername, verifyPassword } from './repo/users.js';
import { resolveToken as resolveAgentToken, touchToken, type AgentScope } from './repo/agent-tokens.js';
import { ensureSettings } from './repo/settings.js';

interface SessionRow {
  token: string;
  user_id: string;
  device_id: string | null;
  kind: string;
  username: string;
  role: string;
  disabled: boolean;
  created_at: Date;
  expires_at: Date;
}

export interface Session {
  token: string;
  user: User;
  device: Device | null;
  kind: 'user' | 'dashboard' | 'agent';
  /** 仅 agent 会话有，MCP 工具按它限制读写 */
  scope?: AgentScope;
  agentTokenId?: string;
}

/* 登录限流：只记失败，按用户名 + IP。15 分钟 8 次 */
const fails = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 8;

function rateKey(username: string, ip: string) {
  return `${username.toLowerCase()}|${ip}`;
}

function tooMany(key: string): boolean {
  const e = fails.get(key);
  if (!e) return false;
  if (e.until < now()) {
    fails.delete(key);
    return false;
  }
  return e.count >= MAX_FAILS;
}

function noteFail(key: string) {
  const e = fails.get(key);
  if (!e || e.until < now()) fails.set(key, { count: 1, until: now() + WINDOW_MS });
  else e.count += 1;
}

function noteSuccess(key: string) {
  fails.delete(key);
}

export async function login(
  req: LoginRequest, ip: string,
): Promise<LoginResponse | { error: string }> {
  const key = rateKey(req.username ?? '', ip ?? '');
  if (tooMany(key)) return { error: 'RATE_LIMITED' };

  const user = await getUserByUsername(req.username ?? '');
  if (!user || !user.passwordHash || user.disabled) {
    noteFail(key);
    // 用户名不存在和口令错误返回同一个错误，避免枚举用户名
    return { error: 'BAD_CREDENTIALS' };
  }
  // 口令校验本身也要跑，否则不存在用户的响应时间会明显更短
  if (!verifyPassword(req.password ?? '', user.passwordHash)) {
    noteFail(key);
    return { error: 'BAD_CREDENTIALS' };
  }
  noteSuccess(key);

  const tok = newToken();
  const expires = new Date(now() + env.SESSION_TTL_MS);
  let device: Device | null = null;

  if (req.machineId?.trim()) {
    device = await upsertDeviceByMachine({
      machineId: req.machineId.trim(),
      userId: user.id,
      name: req.deviceName || '未命名设备',
      platform: req.platform,
      transport: req.transport,
      ip,
    });
    // 设备随用户走：同机换人登录，旧用户的会话立即失效
    await run(
      `DELETE FROM sessions WHERE device_id = $1 AND user_id <> $2`,
      [device.id, user.id],
    );
  }

  await run(
    `INSERT INTO sessions (token, user_id, device_id, kind, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [tok, user.id, device?.id ?? null, device ? 'user' : 'dashboard', expires],
  );
  await ensureSettings(user.id);

  return {
    token: tok,
    user: {
      id: user.id, username: user.username, role: user.role,
      disabled: user.disabled, createdAt: user.createdAt,
    },
    device,
  };
}

export async function logout(tok: string) {
  await run('DELETE FROM sessions WHERE token = $1', [tok]);
}

export async function resolveSession(req: FastifyRequest): Promise<Session | null> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const q = (req.query as { token?: string } | undefined)?.token;
  const tok = bearer ?? q;
  if (!tok) return null;

  const row = await one<SessionRow>(
    `SELECT s.token, s.user_id, s.device_id, s.kind, s.created_at, s.expires_at,
            u.username, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [tok],
  );
  if (row) {
    if (new Date(row.expires_at).getTime() < now()) {
      await run('DELETE FROM sessions WHERE token = $1', [tok]);
      return null;
    }
    if (row.disabled) return null;
    // 滑动续期：剩余不足一半就推满，但不超过绝对上限。
    // 每次推满后要再过半个窗口才写一次库，不需要额外节流。
    const hardCap = new Date(row.created_at).getTime() + env.SESSION_MAX_MS;
    if (hardCap <= now()) {
      await run('DELETE FROM sessions WHERE token = $1', [tok]);
      return null;
    }
    const expires = new Date(row.expires_at).getTime();
    if (expires - now() < env.SESSION_TTL_MS / 2) {
      const next = Math.min(now() + env.SESSION_TTL_MS, hardCap);
      if (next > expires) {
        await run('UPDATE sessions SET expires_at = $2 WHERE token = $1', [tok, new Date(next)]);
      }
    }
    const device = row.device_id ? (await getDevice(row.device_id)) ?? null : null;
    return {
      token: tok,
      user: {
        id: row.user_id, username: row.username, role: row.role as Role,
        disabled: !!row.disabled, createdAt: 0,
      },
      device,
      kind: row.kind as Session['kind'],
    };
  }

  // Agent 令牌是独立凭证，不进 sessions 表，也不借登录会话的身份
  const agent = await resolveAgentToken(tok);
  if (!agent) return null;
  const user = await getUser(agent.userId);
  if (!user || user.disabled) return null;
  // 云端 agent 没有 machineId，就不关联设备；有机器时不能借令牌把设备抢回来
  let device = null;
  if (agent.machineId) {
    const owner = await machineOwner(agent.machineId);
    if (owner && owner !== user.id) return null;
    device = await getByMachineId(agent.machineId);
    if (!device) {
      device = await upsertDeviceByMachine({
        machineId: agent.machineId,
        userId: user.id,
        name: 'Agent',
        platform: 'windows',
        transport: 'ws',
      });
    }
  }
  await touchToken(agent.id);
  return {
    token: tok,
    user,
    device,
    kind: 'agent',
    scope: agent.scope,
    agentTokenId: agent.id,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const s = await resolveSession(req);
  req.session = s;
  if (!s) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
  }
}

/** 主 API 只认登录会话。Agent 令牌只能走 MCP，管理员接口也不能借它提权 */
export async function requireHuman(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.session!.kind === 'agent') {
    await reply.code(403).send({
      error: 'AGENT_TOKEN_SCOPE', message: 'Agent 令牌只能用于 MCP，请用账号密码登录',
    });
  }
}

/** MCP 只认 agent 令牌。登录 token 调不了，避免一把钥匙开所有门 */
export async function requireAgent(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.session!.kind !== 'agent') {
    await reply.code(403).send({
      error: 'AGENT_TOKEN_REQUIRED', message: 'MCP 只接受 Agent 令牌，请在客户端签发',
    });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    return;
  }
  if (req.session.user.role !== 'admin') {
    await reply.code(403).send({ error: 'FORBIDDEN', message: '需要管理员权限' });
  }
}
