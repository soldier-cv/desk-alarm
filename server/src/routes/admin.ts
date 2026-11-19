import type { FastifyInstance } from 'fastify';
import type { Role } from '../../../shared/types.js';
import { requireAdmin, requireHuman } from '../auth.js';
import { log } from '../log.js';
import {
  countUsers, createUser, deleteUser, getUser, listUsers, setDisabled, setPassword, setRole,
} from '../repo/users.js';
import { getOverview } from '../repo/stats.js';
import { clearSettingsCache } from '../repo/settings.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/users', async () => ({ users: await listUsers() }));

  app.post('/admin/users', async (req, reply) => {
    const body = req.body as { username?: string; password?: string; role?: Role };
    const username = body.username?.trim() ?? '';
    const password = body.password ?? '';
    if (!username || password.length < 8) {
      return reply.code(400).send({
        error: 'BAD_REQUEST', message: '用户名不能为空，密码至少 8 位',
      });
    }
    if (body.role && body.role !== 'admin' && body.role !== 'user') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'role 只能是 admin 或 user' });
    }
    try {
      const user = await createUser({ username, password, role: body.role ?? 'user' });
      log.info('admin created user', { by: req.session!.user.username, user: username });
      return reply.code(201).send({ user });
    } catch {
      return reply.code(409).send({ error: 'USERNAME_TAKEN', message: '用户名已被占用' });
    }
  });

  app.patch('/admin/users/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { role?: Role; disabled?: boolean; password?: string };
    const target = await getUser(id);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' });

    if (body.role && body.role !== 'admin' && body.role !== 'user') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'role 只能是 admin 或 user' });
    }
    // 不能把自己降成普通用户或禁用，否则没人能再管用户
    if (id === req.session!.user.id && (body.role === 'user' || body.disabled === true)) {
      return reply.code(400).send({ error: 'SELF_LOCKOUT', message: '不能禁用或降级自己' });
    }
    // 最后一个管理员不能被禁用或降级
    if (target.role === 'admin' && (body.role === 'user' || body.disabled === true)) {
      const admins = (await listUsers()).filter((u) => u.role === 'admin' && !u.disabled);
      if (admins.length <= 1) {
        return reply.code(400).send({ error: 'LAST_ADMIN', message: '至少要保留一个启用的管理员' });
      }
    }

    if (body.role) await setRole(id, body.role);
    if (body.disabled !== undefined) await setDisabled(id, body.disabled);
    if (body.password) {
      if (body.password.length < 8) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: '密码至少 8 位' });
      }
      await setPassword(id, body.password);
    }
    clearSettingsCache(id);
    return { user: await getUser(id) };
  });

  app.delete('/admin/users/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === req.session!.user.id) {
      return reply.code(400).send({ error: 'SELF_DELETE', message: '不能删除自己' });
    }
    const target = await getUser(id);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' });
    if (target.role === 'admin' && (await countUsers()) <= 1) {
      return reply.code(400).send({ error: 'LAST_ADMIN', message: '不能删除最后一个用户' });
    }
    await deleteUser(id);
    clearSettingsCache(id);
    log.info('admin deleted user', { by: req.session!.user.username, user: target.username });
    return { ok: true };
  });

  app.get('/admin/overview', async () => getOverview());
}
