import type { FastifyInstance } from 'fastify';
import type { AckAction, ClientMessage, DismissAction, ServerMessage } from '../../../shared/types.js';
import { resolveSession } from '../auth.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { findMissed, markAcked } from '../repo/deliveries.js';
import { ackEntry, dismissEntry, getEntry } from '../repo/entries.js';
import { listDevices, markOfflineHint, markOnline } from '../repo/devices.js';
import { getSettings } from '../repo/settings.js';

export async function streamRoutes(app: FastifyInstance) {
  app.get('/stream', { websocket: true }, (socket, req) => {
    void (async () => {
      const url = new URL(req.url, 'http://x');
      // 浏览器 WebSocket 不能自定义 header，token 只能走 query
      const session = await resolveSession({
        headers: {},
        query: { token: url.searchParams.get('token') },
      } as never);

      if (!session) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const device = session.device;
      const client = hub.add(device.id, socket);
      await markOnline(device.id);
      log.info('ws connected', { device: device.name, connections: hub.connectionCount });

      // welcome 带漏掉的提醒，客户端一上线就知道该补什么
      hub.send(client, {
        t: 'welcome',
        serverTs: Date.now(),
        deviceId: device.id,
        missed: await findMissed(device.id),
        settings: await getSettings(),
      });
      hub.broadcast({ t: 'devices.changed', devices: await listDevices() });

      socket.on('message', (buf) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(buf));
        } catch {
          return;
        }
        void handle(msg).catch((err) => {
          log.error('ws handle failed', err);
        });
      });

      async function handle(msg: ClientMessage) {
        switch (msg.t) {
          case 'ping':
            hub.send(client, { t: 'pong', at: msg.at });
            break;

          case 'entry.ack':
            await onAck(msg.entryId, msg.action, msg.snoozeTo);
            break;

          case 'entry.dismiss':
            await onDismiss(msg.entryId, msg.reason);
            break;

          default:
            break;
        }
      }

      /**
       * 确认。走 WS 而不是 HTTP 是为了让「响铃的那台设备」零延迟停铃，
       * 不依赖它还有一条可用的 HTTP 连接
       */
      async function onAck(entryId: string, action: AckAction, snoozeToMs?: number) {
        const cur = await getEntry(entryId);
        if (!cur) return;

        await markAcked(entryId, device.id, action);

        if (action === 'silence') {
          // 只压掉这一次，条目本身不动
          hub.broadcast({
            t: 'entry.acked', entryId,
            deviceId: device.id, deviceName: device.name, action,
          });
          return;
        }

        let updated;
        try {
          updated = await ackEntry(entryId, action, device.name, snoozeToMs);
        } catch {
          return;
        }

        hub.broadcast({ t: 'entry.updated', entry: updated });
        // 关键广播：其它正在响的设备收到后立刻静音并降级显示
        hub.broadcast({
          t: 'entry.acked', entryId,
          deviceId: device.id, deviceName: device.name, action,
        });
        log.info('ws ack', { entryId, action, by: device.name });
      }

      /** 弱提示的忽略。和 ack 走同一个广播，好让别处的横幅跟着收 */
      async function onDismiss(entryId: string, reason?: string) {
        const cur = await getEntry(entryId);
        if (!cur) return;
        try {
          const r = await dismissEntry(entryId, device.id, device.name, reason);
          await markAcked(entryId, device.id, 'dismiss');
          hub.broadcast({ t: 'entry.updated', entry: r.entry });
          hub.broadcast({
            t: 'entry.acked', entryId,
            deviceId: device.id, deviceName: device.name, action: 'dismiss' as DismissAction,
          });
          if (r.suggestion && r.entry.strength === 'weak') {
            hub.broadcast({
              t: 'entry.downgraded', entry: r.entry,
              dismissCount: r.dismissCount, reason: r.suggestion,
            });
          }
          log.info('ws dismiss', { entryId, count: r.dismissCount, by: device.name });
        } catch { /* 条目可能已经删了 */ }
      }

      socket.on('close', () => {
        hub.remove(client);
        void markOfflineHint(device.id);
        void (async () => {
          hub.broadcast({ t: 'devices.changed', devices: await listDevices() });
        })();
        log.info('ws closed', { device: device.name, connections: hub.connectionCount });
      });

      socket.on('error', () => hub.remove(client));
    })().catch((err) => {
      log.error('ws setup failed', err);
      try { socket.close(1011, 'setup failed'); } catch { /* ignore */ }
    });
  });
}

export type { ServerMessage };
