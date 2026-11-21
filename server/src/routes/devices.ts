import type { FastifyInstance } from 'fastify';
import type { LoginRequest } from '../../../shared/types.js';
import { login, logout, requireHuman } from '../auth.js';
import { setPushToken } from '../repo/deliveries.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { one } from '../db.js';
import {
  deleteDevice, getDeviceOwned, listDevices, renameDevice, setLocked, setPushEnabled,
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

  // 只动当前会话自己的设备：锁的是「这一台」，不是把账号下所有设备一起锁掉
  app.post('/devices/lock', { preHandler: requireHuman }, async (req, reply) => {
    const session = req.session!;
    const dev = session.device;
    if (!dev) {
      return reply.code(404).send({ error: 'NO_DEVICE', message: '当前会话没有关联设备' });
    }
    // 手机锁屏/切后台是常态，锁了就拿不到提醒；这个能力只对桌面端有意义
    if (dev.platform === 'android' || dev.platform === 'ios') {
      return reply.code(400).send({ error: 'UNSUPPORTED_PLATFORM', message: '移动端不支持锁定' });
    }

    const body = req.body as { locked?: boolean; pin?: string; reason?: 'manual' | 'system' };
    if (typeof body.locked !== 'boolean') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'locked 必须是布尔值' });
    }
    if (body.reason !== undefined && body.reason !== 'manual' && body.reason !== 'system') {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'reason 只能是 manual 或 system' });
    }

    const userId = session.user.id;
    // PIN 现在是设备本机的屏幕锁，服务端不持有也不校验；locked 只控制投递层。
    // 客户端本地验过 PIN 后才会请求解锁，旧的 pin 字段留着兼容但忽略。
    await setLocked(
      dev.id,
      body.locked,
      body.locked ? (body.reason ?? 'manual') : undefined,
    );

    const devices = await listDevices(userId);
    hub.broadcastToUser(userId, { t: 'devices.changed', devices });
    const updated = devices.find((d) => d.id === dev.id)!;
    session.device = updated;
    return { device: updated };
  });

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
