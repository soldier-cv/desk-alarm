import type { FastifyInstance } from 'fastify';
import type { LoginRequest } from '../../../shared/types.js';
import { invalidateTransport, login, logout, requireAuth } from '../auth.js';
import { setPushToken } from '../repo/deliveries.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { one, run } from '../db.js';
import {
  deleteDevice, getDevice, listDevices, renameDevice, setPushEnabled, touch,
} from '../repo/devices.js';

export async function deviceRoutes(app: FastifyInstance) {
  /* -------------------------------------------------------- 登录鉴权 */

  app.post('/auth/login', async (req, reply) => {
    const out = await login(req.body as LoginRequest);
    if ('error' in out) {
      return reply.code(401).send({ error: 'BAD_PASSCODE', message: '口令不对' });
    }
    log.info('login', {
      device: out.device.name, platform: out.device.platform, transport: out.device.transport,
    });
    return out;
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
    await logout(req.session!.token);
    return { ok: true };
  });

  app.get('/auth/whoami', { preHandler: requireAuth }, async (req) => ({ device: req.session!.device }));

  /* ------------------------------------------------------------ 设备 */

  app.get('/devices', { preHandler: requireAuth }, async () => ({ devices: await listDevices() }));

  app.patch('/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { name?: string; pushEnabled?: boolean; pushToken?: string | null };
    if (body.name !== undefined) await renameDevice(id, body.name);
    if (body.pushEnabled !== undefined) await setPushEnabled(id, body.pushEnabled);
    if (body.pushToken !== undefined) {
      const dev = await getDevice(id);
      if (!dev) return reply.code(404).send({ error: 'NOT_FOUND', message: '设备不存在' });
      await setPushToken(id, null, body.pushToken);
    }

    const devices = await listDevices();
    hub.broadcast({ t: 'devices.changed', devices });
    const updated = devices.find((d) => d.id === id);
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND', message: '设备不存在' });
    return { device: updated };
  });

  /**
   * 删除前检查有没有排给它的提醒。不拦的话会出现「提醒发到没人用的设备」然后永远补发
   */
  app.delete('/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const pinned = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM entry_devices WHERE device_id = $1', [id],
    );
    if ((pinned?.n ?? 0) > 0) {
      return reply.code(409).send({
        error: 'DEVICE_IN_USE',
        message: `还有 ${pinned!.n} 条提醒指定推送到这台设备，先改推送范围再删`,
      });
    }
    await deleteDevice(id);
    const devices = await listDevices();
    hub.broadcast({ t: 'devices.changed', devices });
    log.info('device removed', { id });
    return { ok: true, devices };
  });

  /**
   * 试响。让用户确认这台设备能不能真的弹通知。
   * 只能对自己发，避免被人远程弹窗
   */
  app.post('/devices/:id/ping', { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id !== req.session!.device.id) {
      return reply.code(403).send({
        error: 'NOT_SELF', message: '设备只允许对自己发试响，避免被人远程弹窗',
      });
    }
    const dev = req.session!.device;
    const now = Date.now();

    // 桌面试响直接走 WS，绕开 FCM，这样测的是本机通知能力而不是网络
    if (dev.transport === 'ws') {
      const ok = hub.sendTo(id, {
        t: 'entry.fired',
        entry: {
          id: 'ping', text: '试响：能听到声音说明这台设备没问题', kind: 'text',
          url: null, path: null, note: null, remindAt: now, repeat: 'none',
          status: 'pending', strength: 'strong', bypassQuiet: true, hard: true,
          firedAt: now, doneAt: null, doneDevice: null, snoozeCount: 0,
          dismissCount: 0, source: 'app', devices: ['*'], version: 1,
          createdAt: now, updatedAt: now,
        },
        serverTs: now, repeat: 'none', strength: 'strong', transport: 'ws',
      });
      return { ok, via: 'ws' };
    }

    // 手机走 FCM，用户能收到就说明 token 是好的
    const { transportFor } = await import('../transport/index.js');
    const r = await transportFor(dev.transport).send(id, {
      id: 'ping', text: '试响：能收到这条说明这台手机推送是通的', kind: 'text',
      url: null, path: null, note: null, remindAt: now, repeat: 'none',
      status: 'pending', strength: 'strong', bypassQuiet: true, hard: true,
      firedAt: now, doneAt: null, doneDevice: null, snoozeCount: 0,
      dismissCount: 0, source: 'app', devices: ['*'], version: 1,
      createdAt: now, updatedAt: now,
    }, now);
    return reply.code(r.ok ? 200 : 502).send({
      ok: r.ok, via: dev.transport, error: r.error, messageId: r.messageId,
    });
  });
}
