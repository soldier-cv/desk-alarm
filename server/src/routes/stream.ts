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

      // Agent 令牌只走 MCP；Web / 看板没有设备行，也不建立实时通道
      if (!session || session.kind === 'agent' || !session.device) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const userId = session.user.id;
      const device = session.device;
      const client = hub.add(userId, device.id, socket);
      await markOnline(device.id);
      log.info('ws connected', {
        user: session.user.username, device: device.name, connections: hub.connectionCount,
      });

      hub.send(client, {
        t: 'welcome',
        serverTs: Date.now(),
        deviceId: device.id,
        missed: await findMissed(userId, device.id),
        settings: await getSettings(userId),
      });
      hub.broadcastToUser(userId, { t: 'devices.changed', devices: await listDevices(userId) });

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

      async function onAck(entryId: string, action: AckAction, snoozeToMs?: number) {
        const cur = await getEntry(entryId, userId);
        if (!cur) return;

        await markAcked(entryId, device.id, action);

        if (action === 'silence') {
          hub.broadcastToUser(userId, {
            t: 'entry.acked', entryId,
            deviceId: device.id, deviceName: device.name, action,
          });
          return;
        }

        let updated;
        try {
          updated = await ackEntry(entryId, userId, action, device.name, snoozeToMs);
        } catch {
          return;
        }

        hub.broadcastToUser(userId, { t: 'entry.updated', entry: updated });
        hub.broadcastToUser(userId, {
          t: 'entry.acked', entryId,
          deviceId: device.id, deviceName: device.name, action,
        });
        log.info('ws ack', { entryId, action, by: device.name });
      }

      async function onDismiss(entryId: string, reason?: string) {
        const cur = await getEntry(entryId, userId);
        if (!cur) return;
        try {
          const r = await dismissEntry(entryId, userId, device.id, device.name, reason);
          await markAcked(entryId, device.id, 'dismiss');
          hub.broadcastToUser(userId, { t: 'entry.updated', entry: r.entry });
          hub.broadcastToUser(userId, {
            t: 'entry.acked', entryId,
            deviceId: device.id, deviceName: device.name, action: 'dismiss' as DismissAction,
          });
          if (r.suggestion && r.entry.strength === 'weak') {
            hub.broadcastToUser(userId, {
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
          hub.broadcastToUser(userId, { t: 'devices.changed', devices: await listDevices(userId) });
        })();
        log.info('ws closed', { device: device.name, connections: hub.connectionCount });
      });

      socket.on('error', () => hub.remove(client));
    })().catch((err) => {
      log.error('ws setup failed', err);
    });
  });
}
