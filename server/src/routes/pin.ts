import type { FastifyInstance } from 'fastify';
import { requireHuman } from '../auth.js';
import { clearPin, getUserSecrets, setPin, verifyPassword } from '../repo/users.js';

const PIN_RE = /^\d{4,12}$/;

export async function pinRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireHuman);

  app.post('/pin', async (req, reply) => {
    const userId = req.session!.user.id;
    const body = req.body as { pin?: string; currentPassword?: string };
    const pin = body.pin ?? '';
    if (!PIN_RE.test(pin)) {
      return reply.code(400).send({ error: 'BAD_PIN_FORMAT', message: 'PIN 必须是 4-12 位数字' });
    }

    const secrets = await getUserSecrets(userId);
    if (!secrets) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '请先登录' });
    }
    // 第一次设 PIN 不需要密码；改 PIN 必须拿账号密码证明是本人
    if (secrets.pinHash && (!body.currentPassword ||
        !verifyPassword(body.currentPassword, secrets.passwordHash))) {
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
