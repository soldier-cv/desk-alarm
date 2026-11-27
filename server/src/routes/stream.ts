import type { FastifyInstance } from 'fastify';
import type { ClientMessage, Nudge, ServerMessage } from '../../../shared/types.js';
import { resolveSession } from '../auth.js';
import { followUp } from '../drive.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { listMissed } from '../repo/nudges.js';
import { getPursuit, listPursuits } from '../repo/pursuits.js';
import { updateStep } from '../repo/steps.js';
import { listDevices, markOfflineHint, markOnline, touch } from '../repo/devices.js';
import { getSettings } from '../repo/settings.js';
import { inQuietHours } from '../policy.js';

export async function streamRoutes(app: FastifyInstance) {
  app.get('/stream', { websocket: true }, (socket, req) => {
    void (async () => {
      const url = new URL(req.url, 'http://x');
      // 浏览器 WebSocket 不能自定义 header，token 只能走 query
      const session = await resolveSession({
        headers: {},
        query: { token: url.searchParams.get('token') },
      } as never);

      // Agent 令牌只走 MCP；看板没有设备行，也不建立实时通道
      if (!session || session.kind === 'agent' || !session.device) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const userId = session.user.id;
      const device = session.device;
      const client = hub.add(userId, device.id, socket);
      const nowMs = Date.now();
      const missed = await listMissed(userId, nowMs);
      const settings = await getSettings(userId);
      const activePursuits = await listPursuits(userId, { status: 'active' });
      const overdue = inQuietHours(settings, nowMs)
        ? []
        : activePursuits
            .filter((p) =>
              p.dueAt !== null && p.dueAt <= nowMs &&
              (p.deviceIds.length === 0 || p.deviceIds.includes(device.id)),
            )
            .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
      await markOnline(device.id);
      log.info('ws connected', {
        user: session.user.username, device: device.name, connections: hub.connectionCount,
      });
      const devices = await listDevices(userId);

      const welcome: ServerMessage & { missed: Nudge[] } = {
        t: 'welcome',
        serverTs: nowMs,
        deviceId: device.id,
        settings,
        devices,
        missed,
        overdue,
      };
      hub.send(client, welcome);
      // 新设备上线后让同账号其它端立刻刷新设备列表，不必等下次登录或改设置
      hub.broadcastToUser(userId, { t: 'devices.changed', devices });

      socket.on('message', (buf) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(buf)) as ClientMessage;
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
            // 心跳必须刷新 last_seen_at，否则 sweepOffline 会把在线设备误判成离线
            await touch(device.id);
            hub.send(client, { t: 'pong', at: msg.at });
            break;
          case 'pursuit.followup':
            await onFollowup(msg.pursuitId, msg.action, msg.note, msg.version);
            break;
          case 'pursuit.step':
            await onStep(msg.stepId, msg.state);
            break;
          default:
            break;
        }
      }

      async function onFollowup(
        pursuitId: string,
        action: Extract<ClientMessage, { t: 'pursuit.followup' }>['action'],
        note: string | undefined,
        version: number,
      ) {
        await touch(device.id);
        try {
          const pursuit = await followUp(pursuitId, userId, { action, note, version });
          hub.broadcastToUser(userId, { t: 'pursuit.followed', pursuit, action });
          log.info('ws followup', { pursuitId, action, by: device.name });
        } catch (err) {
          log.warn('ws followup failed', { pursuitId, error: (err as Error).message });
        }
      }

      async function onStep(stepId: string, state: Extract<ClientMessage, { t: 'pursuit.step' }>['state']) {
        await touch(device.id);
        try {
          const step = await updateStep(stepId, userId, { state });
          if (!step) return;
          const pursuit = await getPursuit(step.pursuitId, userId);
          if (pursuit) hub.broadcastToUser(userId, { t: 'pursuit.stepped', pursuit });
          log.info('ws step', { stepId, state, by: device.name });
        } catch (err) {
          log.warn('ws step failed', { stepId, error: (err as Error).message });
        }
      }

      socket.on('close', () => {
        hub.remove(client);
        // 同一设备还留着别的连接时不能标离线
        if (!hub.isOnline(device.id)) void markOfflineHint(device.id);
        log.info('ws closed', { device: device.name, connections: hub.connectionCount });
      });

      socket.on('error', () => hub.remove(client));
    })().catch((err) => {
      log.error('ws setup failed', err);
    });
  });
}
