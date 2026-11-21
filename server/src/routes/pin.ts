/**
 * 已废弃：账号级 PIN。PIN 现在只存各设备本机（app/src/device-pin.ts），
 * 不入库也不传服务端。这几个接口留着兼容还没升级的老客户端，新客户端不再调用。
 */
import type { FastifyInstance } from 'fastify';
import { requireHuman } from '../auth.js';
import { clearPin, getUserSecrets, setPin, verifyPassword } from '../repo/users.js';

const PIN_RE = /^\d{6}$/;

export async function pinRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);

  app.post('/pin', async (req, reply) => {
    const userId = req.session!.user.id;
    const body = req.body as { pin?: string; currentPassword?: string };
    const pin = body.pin ?? '';
    if (!PIN_RE.test(pin)) {
      return reply.code(400).send({ error: 'BAD_PIN_FORMAT', message: 'PIN 必须是 6 位数字' });
    }

    const secrets = await getUserSecrets(userId);
    if (!secrets) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    // 不管是不是第一次，设 PIN 都要账号密码：否则填错密码也会被当成"首次设置"放行
    if (!body.currentPassword || !verifyPassword(body.currentPassword, secrets.passwordHash)) {
      return reply.code(401).send({ error: 'BAD_PASSWORD', message: '账号密码不对' });
    }

    await setPin(userId, pin);
    return { ok: true };
  });

  app.delete('/pin', async (req, reply) => {
    const userId = req.session!.user.id;
    const body = req.body as { currentPassword?: string };
    const secrets = await getUserSecrets(userId);
    if (!body.currentPassword || !secrets ||
        !verifyPassword(body.currentPassword, secrets.passwordHash)) {
      return reply.code(401).send({ error: 'BAD_PASSWORD', message: '账号密码不对' });
    }
    await clearPin(userId);
    return { ok: true };
  });
}
