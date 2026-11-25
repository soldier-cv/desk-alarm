/**
 * 投递通道抽象。
 *
 * 目前只有 WebSocket 一条通道：Android 常驻前台服务维持连接，桌面端本来就是常驻进程。
 * 失败不算「提醒丢了」，outbox 会重试，重连后 welcome 带 missed 补发。
 * 注册表留着，方便以后接厂商推送。
 */
import type { NudgeChannel, NudgeLevel, Pursuit, ServerMessage } from '../../../shared/types.js';
import { hub } from '../hub.js';
import { log } from '../log.js';

export type TransportName = 'ws';

/** A 模块调度器调用 send 时传的载荷 */
export interface NudgePayload {
  pursuit: Pursuit;
  level: NudgeLevel;
  channel: NudgeChannel;
  reason: string;
  serverTs?: number;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** 明确的「这个 token 废了」，不该重试 */
  fatal?: boolean;
}

export interface Transport {
  readonly name: TransportName;
  /** 这台设备当前能不能立刻收到。false 时 outbox 会等 */
  available(deviceId: string): boolean;
  send(deviceId: string, msg: ServerMessage): Promise<SendResult>;
}

// 只有强弱两种表现：强提醒弹接管窗，弱提醒走通知
function presentationChannel(level: NudgeLevel, _requested: NudgeChannel): NudgeChannel {
  return level === 4 ? 'takeover' : 'notification';
}

function nudgeMessage(p: NudgePayload): ServerMessage {
  return {
    t: 'pursuit.nudge',
    pursuit: p.pursuit,
    level: p.level,
    channel: presentationChannel(p.level, p.channel),
    reason: p.reason,
    serverTs: p.serverTs ?? Date.now(),
  };
}

/** 调度器的唯一入口。也接受已经组装好的 ServerMessage，方便测试与补发 */
export async function send(deviceId: string, payload: NudgePayload | ServerMessage): Promise<SendResult> {
  const msg = 't' in payload ? payload : nudgeMessage(payload);
  const transport = transportFor('ws');
  if (!transport.available(deviceId)) return { ok: false, error: '设备不在线' };
  return transport.send(deviceId, msg);
}

/* ------------------------------------------------------------ WebSocket */

class WebSocketTransport implements Transport {
  readonly name = 'ws' as const;

  available(deviceId: string): boolean {
    return hub.isOnline(deviceId);
  }

  async send(deviceId: string, msg: ServerMessage): Promise<SendResult> {
    if (!this.available(deviceId)) {
      return { ok: false, error: '设备不在线' };
    }
    const sent = hub.sendTo(deviceId, msg);
    return sent ? { ok: true } : { ok: false, error: 'socket 写入失败' };
  }
}

/* ------------------------------------------------------------- 注册表 */

const registry = new Map<TransportName, Transport>([
  ['ws', new WebSocketTransport()],
]);

export function registerTransport(t: Transport) {
  registry.set(t.name, t);
}

export function transportFor(name: TransportName | null | undefined): Transport {
  const t = registry.get((name ?? 'ws') as TransportName);
  if (t) return t;
  log.warn('transport', `未知通道 ${name}，退回 ws`);
  return registry.get('ws')!;
}

export function initTransports() {
  log.info('transport', `已注册通道: ${[...registry.keys()].join(', ')}`);
}
