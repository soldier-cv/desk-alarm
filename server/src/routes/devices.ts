import type { FastifyInstance } from 'fastify';
import type { LoginRequest, Pursuit } from '../../../shared/types.js';
import { login, logout, requireHuman } from '../auth.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { one } from '../db.js';
import {
  deleteDevice, getDeviceOwned, listDevices, renameDevice, setPushEnabled,
} from '../repo/devices.js';

export async function deviceRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const out = await login(
      req.body as LoginRequest,
      (req.ip ?? '') as string,
    );
    if ('error' in out) {
      const rate = out.error === 'RATE_LIMITED';
      return reply.code(rate ? 429 : 401).send({
        error: out.error,
        message: rate ? '尝试次数太多，15 分钟后再试' : '用户名或密码不对',
      });
    }
    log.info('login', {
      user: out.user.username,
      device: out.device?.name ?? '(web)',
      platform: (req.body as LoginRequest).platform,
    });
    return out;
  });

  app.post('/auth/logout', { preHandler: requireHuman }, async (req) => {
    await logout(req.session!.token);
    return { ok: true };
  });

  app.get('/auth/whoami', { preHandler: requireHuman }, async (req) => ({
    user: req.session!.user,
    device: req.session!.device,
  }));

  app.get('/devices', { preHandler: requireHuman }, async (req) => ({
    devices: await listDevices(req.session!.user.id),
  }));

  app.patch('/devices/:id', { preHandler: requireHuman }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = req.session!.user.id;
    const owned = await getDeviceOwned(id, userId);
    if (!owned) return reply.code(404).send({ error: 'NOT_FOUND', message: '设备不存在' });

    const body = req.body as { name?: string; pushEnabled?: boolean };
    if (body.name !== undefined) await renameDevice(id, userId, body.name);
    if (body.pushEnabled !== undefined) await setPushEnabled(id, userId, body.pushEnabled);

    const devices = await listDevices(userId);
    hub.broadcastToUser(userId, { t: 'devices.changed', devices });
    const updated = devices.find((d) => d.id === id)!;
    return { device: updated };
  });

  app.delete('/devices/:id', { preHandler: requireHuman }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const userId = req.session!.user.id;
    if (!await getDeviceOwned(id, userId)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '设备不存在' });
    }
    const pinned = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pursuit_devices WHERE device_id = $1', [id],
    );
    if ((pinned?.n ?? 0) > 0) {
      return reply.code(409).send({
        error: 'DEVICE_IN_USE',
        message: `还有 ${pinned!.n} 条提醒指定推送到这台设备，先改推送范围再删`,
      });
    }
    await deleteDevice(id, userId);
    const devices = await listDevices(userId);
    hub.broadcastToUser(userId, { t: 'devices.changed', devices });
    log.info('device removed', { id });
    return { ok: true, devices };
  });

  app.post('/devices/:id/ping', { preHandler: requireHuman }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const dev = req.session!.device;
    if (!dev || id !== dev.id) {
      return reply.code(403).send({
        error: 'NOT_SELF', message: '设备只允许对自己发试响，避免被人远程弹窗',
      });
    }
    const now = Date.now();
    const sample: Pursuit = {
      id: 'ping', userId: req.session!.user.id,
      text: '试响：能听到声音说明这台设备没问题', note: null, kind: 'text',
      url: null, path: null, nature: 'one_off', strength: 'strong', importance: 3, energy: 'low',
      dueAt: now, recurrence: null, context: null, commitment: null,
      status: 'active', importanceSort: 0, version: 1,
      createdAt: now, updatedAt: now, completedAt: null, lastActivityAt: now,
      progress: 0, stalenessMs: 0, weight: 0, steps: [], deviceIds: [id], source: 'app',
    };
    const msg = {
      t: 'pursuit.nudge' as const,
      pursuit: sample, level: 4 as const, channel: 'takeover' as const,
      reason: '试响', serverTs: now,
    };

    if (dev.transport === 'ws') {
      const ok = hub.sendTo(id, msg);
      return { ok, via: 'ws' };
    }

    const { send } = await import('../transport/index.js');
    const r = await send(id, msg);
    return reply.code(r.ok ? 200 : 502).send({
      ok: r.ok, via: dev.transport, error: r.error, messageId: r.messageId,
    });
  });
}
