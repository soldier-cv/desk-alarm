import type { FastifyInstance } from 'fastify';
import type { LoginRequest } from '../../../shared/types.js';
import { login, logout, requireHuman } from '../auth.js';
import { setPushToken } from '../repo/deliveries.js';
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

    const body = req.body as { name?: string; pushEnabled?: boolean; pushToken?: string | null };
    if (body.name !== undefined) await renameDevice(id, userId, body.name);
    if (body.pushEnabled !== undefined) await setPushEnabled(id, userId, body.pushEnabled);
    if (body.pushToken !== undefined) await setPushToken(id, null, body.pushToken);

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
      'SELECT count(*)::int AS n FROM entry_devices WHERE device_id = $1', [id],
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
    const sample = {
      id: 'ping', text: '试响：能听到声音说明这台设备没问题', kind: 'text' as const,
      url: null, path: null, note: null, remindAt: now, repeat: 'none' as const,
      status: 'pending' as const, strength: 'strong' as const, bypassQuiet: true, hard: true,
      firedAt: now, doneAt: null, doneDevice: null, snoozeCount: 0,
      dismissCount: 0, source: 'app' as const, devices: ['*'], version: 1,
      createdAt: now, updatedAt: now,
    };

    if (dev.transport === 'ws') {
      const ok = hub.sendTo(id, {
        t: 'entry.fired', entry: sample,
        serverTs: now, repeat: 'none', strength: 'strong', transport: 'ws',
      });
      return { ok, via: 'ws' };
    }

    const { transportFor } = await import('../transport/index.js');
    const r = await transportFor(dev.transport).send(id, sample, now);
    return reply.code(r.ok ? 200 : 502).send({
      ok: r.ok, via: dev.transport, error: r.error, messageId: r.messageId,
    });
  });
}
