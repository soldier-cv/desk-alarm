/**
 * 投递通道抽象。
 *
 * 为什么需要这个：桌面端进程常驻，WebSocket 一直活着，WS 发了就到了。
 * 手机不行，Android 会在后台杀进程，WS 随时断。手机只能靠 FCM 敲门。
 * 所以投递不能只有一个出口。
 *
 * 契约很简单：send 成功返回 true，失败返回 false 加原因。
 * 失败不算「提醒丢了」，outbox 会重试，重试超时才降级到 missed 补发。
 */
import type { Entry } from '../../../shared/types.js';
import { hub } from '../hub.js';
import { log } from '../log.js';
import { createFcm } from './fcm.js';

export type TransportName = 'ws' | 'fcm' | 'webpush';

export interface SendResult {
  ok: boolean;
  /** 通道自己的回执 id，出问题时排查用 */
  messageId?: string;
  error?: string;
  /** 明确的「这个 token 废了」，不该重试 */
  fatal?: boolean;
}

export interface Transport {
  readonly name: TransportName;
  /** 这台设备当前能不能立刻收到。false 时 outbox 会等 */
  available(deviceId: string): boolean;
  send(deviceId: string, entry: Entry, serverTs: number): Promise<SendResult>;
}

/* ------------------------------------------------------------ WebSocket */

class WebSocketTransport implements Transport {
  readonly name = 'ws' as const;

  available(deviceId: string): boolean {
    return hub.isOnline(deviceId);
  }

  async send(deviceId: string, entry: Entry, serverTs: number): Promise<SendResult> {
    if (!this.available(deviceId)) {
      return { ok: false, error: '设备不在线' };
    }
    const sent = hub.sendTo(deviceId, {
      t: 'entry.fired',
      entry,
      serverTs,
      repeat: entry.repeat,
      strength: entry.strength,
      transport: 'ws' as const,
    });
    return sent ? { ok: true } : { ok: false, error: 'socket 写入失败' };
  }
}

/* -------------------------------------------------------------- FCM */

/** 没配 Firebase 凭据时是个空壳，所有投递都失败。
 *  失败会记进 deliveries.last_error，排查时一眼能看出是配置问题 */
const fcm = createFcm();

/* ------------------------------------------------------------- 注册表 */

const registry = new Map<TransportName, Transport>([
  ['ws', new WebSocketTransport() as Transport],
  ['fcm', fcm],
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
  if (!fcm.available('__probe__')) {
    log.warn('transport', 'FCM 不可用，Android 设备到点只会走 missed 补发');
  }
}
