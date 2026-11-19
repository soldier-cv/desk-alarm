/**
 * 一次性管理员初始化。没有任何 env 账号密码：首次访问的人自己填用户名和两次密码。
 * users 表非空后这两个接口就不允许再写，避免有人事后偷偷加管理员。
 */
import type { FastifyInstance } from 'fastify';
import { token as newToken } from '../env.js';
import { run, tx } from '../db.js';
import { countUsers, getUser, hashPassword } from '../repo/users.js';
import { ensureSettings } from '../repo/settings.js';
import { upsertDeviceByMachine } from '../repo/devices.js';
import { invalidateTransport } from '../repo/deliveries.js';

const SETUP_LOCK = 918273;

export async function setupRoutes(app: FastifyInstance) {
  app.get('/setup/status', async () => ({ needed: (await countUsers()) === 0 }));

  app.post('/setup', async (req, reply) => {
    const body = req.body as {
      username?: string; password?: string; confirmPassword?: string; machineId?: string;
    };
    const username = body.username?.trim() ?? '';
    const password = body.password ?? '';
    if (!username || password.length < 8) {
      return reply.code(400).send({
        error: 'BAD_REQUEST', message: '用户名不能为空，密码至少 8 位',
      });
    }
    if (password !== body.confirmPassword) {
      return reply.code(400).send({ error: 'PASSWORD_MISMATCH', message: '两次密码不一致' });
    }

    let id: string | null = null;
    try {
      // 事务锁住并发初始化：两个人同时点提交也只能建成一个管理员
      id = await tx(async (q) => {
        await q.run('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK]);
        const n = await q.scalar<number>('SELECT count(*)::int AS n FROM users');
        if (Number(n ?? 0) > 0) return null;
        const r = await q.one<{ id: string }>(
          `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin') RETURNING id`,
          [username, hashPassword(password)],
        );
        return r?.id ?? null;
      });
    } catch {
      return reply.code(409).send({ error: 'USERNAME_TAKEN', message: '用户名已被占用' });
    }

    if (!id) {
      return reply.code(409).send({ error: 'ALREADY_SETUP', message: '管理员已初始化，请直接登录' });
    }

    const user = (await getUser(id))!;
    await ensureSettings(user.id);

    // 桌面端带上 machine-id 时顺手续一台设备，初始化完就能收实时提醒
    const machineId = body.machineId?.trim();
    let device = null;
    if (machineId) {
      device = await upsertDeviceByMachine({
        machineId, userId: user.id, name: '我的笔记本', platform: 'windows', transport: 'ws',
      });
      invalidateTransport(device.id);
    }

    const tok = newToken();
    await run(
      `INSERT INTO sessions (token, user_id, device_id, kind, expires_at)
       VALUES ($1,$2,$3,'user', now() + interval '90 days')`,
      [tok, user.id, device?.id ?? null],
    );
    return reply.code(201).send({ token: tok, user, device });
  });
}
