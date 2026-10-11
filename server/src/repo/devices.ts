import type { Device, Platform, TransportName } from '../../../shared/types.js';
import { one, rows, run } from '../db.js';

interface Row {
  id: string;
  name: string;
  platform: string;
  is_self: boolean;
  transport: string;
  push_token: string | null;
  push_enabled: boolean;
  online: boolean;
  last_seen_at: Date;
  created_at: Date;
}

function toDevice(r: Row): Device {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as Platform,
    isSelf: r.is_self,
    transport: (r.transport as TransportName) ?? 'ws',
    pushEnabled: r.push_enabled,
    online: r.online,
    // 有 token 才算配好了。桌面端走 WS，不需要 token
    pushReady: r.transport === 'ws' || !!r.push_token,
    lastSeenAt: new Date(r.last_seen_at).getTime(),
    createdAt: new Date(r.created_at).getTime(),
  };
}

export async function listDevices(): Promise<Device[]> {
  const r = await rows<Row>(
    'SELECT * FROM devices ORDER BY is_self DESC, created_at ASC',
  );
  return r.map(toDevice);
}

export async function getDevice(id: string): Promise<Device | undefined> {
  const r = await one<Row>('SELECT * FROM devices WHERE id = $1', [id]);
  return r ? toDevice(r) : undefined;
}

/**
 * 按设备指纹复用记录。客户端每次启动带同一个 id，
 * 服务端据此判断是新设备还是重连，避免每开一次程序就多出一台设备把推送范围撑爆
 */
export async function upsertDevice(input: {
  id?: string;
  name: string;
  platform: Platform;
  isSelf?: boolean;
  transport?: TransportName;
  pushToken?: string | null;
}): Promise<Device> {
  if (input.id) {
    const existing = await one<Row>('SELECT * FROM devices WHERE id = $1', [input.id]);
    if (existing) {
      await run(
        `UPDATE devices
            SET name = $2, platform = $3, is_self = $4,
                transport = COALESCE($5, transport),
                push_token = COALESCE($6, push_token),
                last_seen_at = now()
          WHERE id = $1`,
        [input.id, input.name, input.platform, input.isSelf ? true : false,
         input.transport ?? null, input.pushToken ?? null],
      );
      return (await getDevice(input.id))!;
    }
  }

  const id = input.id ?? `dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // 第一台登录的 Windows 设备就是「本机」。客户端不该传这个，
  // 让服务端按「谁先来」判定，规则只有一处
  const claimed = input.isSelf === true;
  const isFirst = input.platform === 'windows'
    ? (await one<{ n: number }>('SELECT count(*)::int AS n FROM devices'))!.n === 0
    : false;

  await run(
    `INSERT INTO devices (id, name, platform, is_self, transport, push_token, push_enabled, online, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,false,now())`,
    [id, input.name, input.platform, claimed || isFirst,
     input.transport ?? 'ws', input.pushToken ?? null],
  );
  return (await getDevice(id))!;
}

export async function touchDevice(id: string, online: boolean) {
  await run('UPDATE devices SET last_seen_at = now(), online = $2 WHERE id = $1', [id, online]);
}
/** 只刷心跳，不改在线标记 */
export async function touch(id: string) {
  await run('UPDATE devices SET last_seen_at = now() WHERE id = $1', [id]);
}

/** WS 握手成功时调用。在线标记只有这里会置 true，
 *  之前漏了这一下，导致在线设备列表永远是空的 */
export async function markOnline(id: string) {
  await run('UPDATE devices SET last_seen_at = now(), online = true WHERE id = $1', [id]);
}

/** WS 断开时调用。重连很快，真正的超时下线交给 sweepOffline */
export async function markOfflineHint(id: string) {
  await run('UPDATE devices SET last_seen_at = now(), online = false WHERE id = $1', [id]);
}

export async function renameDevice(id: string, name: string) {
  await run('UPDATE devices SET name = $2 WHERE id = $1', [id, name]);
}

export async function setPushEnabled(id: string, enabled: boolean) {
  await run('UPDATE devices SET push_enabled = $2 WHERE id = $1', [id, enabled]);
}

export async function deleteDevice(id: string) {
  await run('DELETE FROM devices WHERE id = $1', [id]);
}

/** 掉线超过 3 分钟就算离线，防止客户端崩溃后一直挂着「在线」 */
export async function sweepOffline(): Promise<Array<{ id: string }>> {
  return rows<{ id: string }>(
    `UPDATE devices SET online = false
      WHERE online = true AND last_seen_at < now() - interval '3 minutes'
      RETURNING id`,
  );
}
