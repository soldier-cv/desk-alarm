import type { Device, Platform, TransportName } from '../../../shared/types.js';
import { one, rows, run } from '../db.js';

interface Row {
  id: string;
  machine_id: string;
  user_id: string;
  name: string;
  platform: string;
  transport: string;
  push_token: string | null;
  push_enabled: boolean;
  online: boolean;
  locked: boolean;
  lock_reason: string | null;
  last_ip: string | null;
  last_seen_at: Date;
  created_at: Date;
}

function toDevice(r: Row): Device {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform as Platform,
    // 设备身份不再靠「谁先登录」或全局 MCP_DEVICE_ID 猜；保留字段只为兼容旧客户端
    isSelf: false,
    transport: (r.transport as TransportName) ?? 'ws',
    pushEnabled: r.push_enabled,
    online: r.online,
    pushReady: r.transport === 'ws' || !!r.push_token,
    locked: !!r.locked,
    lockReason: r.lock_reason === 'manual' || r.lock_reason === 'system' ? r.lock_reason : null,
    lastIp: r.last_ip,
    lastSeenAt: new Date(r.last_seen_at).getTime(),
    createdAt: new Date(r.created_at).getTime(),
  };
}

export async function listDevices(userId: string): Promise<Device[]> {
  const r = await rows<Row>(
    'SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at ASC', [userId],
  );
  return r.map(toDevice);
}

export async function getDevice(id: string): Promise<Device | undefined> {
  const r = await one<Row>('SELECT * FROM devices WHERE id = $1', [id]);
  return r ? toDevice(r) : undefined;
}

export async function getDeviceOwned(id: string, userId: string): Promise<Device | undefined> {
  const r = await one<Row>('SELECT * FROM devices WHERE id = $1 AND user_id = $2', [id, userId]);
  return r ? toDevice(r) : undefined;
}

export async function getByMachineId(machineId: string): Promise<Device | undefined> {
  const r = await one<Row>('SELECT * FROM devices WHERE machine_id = $1', [machineId]);
  return r ? toDevice(r) : undefined;
}

export async function machineOwner(machineId: string): Promise<string | null> {
  const r = await one<{ user_id: string }>(
    'SELECT user_id FROM devices WHERE machine_id = $1', [machineId],
  );
  return r?.user_id ?? null;
}

/**
 * 按 OS machine-id 复用设备。机器不变、用户可能变：
 * 换人登录时把归属切过去，旧用户的会话由 auth 层清掉
 */
export async function upsertDeviceByMachine(input: {
  machineId: string;
  userId: string;
  name: string;
  platform: Platform;
  transport?: TransportName;
  pushToken?: string | null;
  ip?: string | null;
}): Promise<Device> {
  const existing = await one<Row>(
    'SELECT * FROM devices WHERE machine_id = $1', [input.machineId],
  );
  if (existing) {
    await run(
      `UPDATE devices
          SET user_id = $2, name = $3, platform = $4,
              transport = COALESCE($5, transport),
              push_token = COALESCE($6, push_token),
              last_ip = COALESCE($7, last_ip),
              last_seen_at = now()
        WHERE id = $1`,
      [existing.id, input.userId, input.name, input.platform,
       input.transport ?? null, input.pushToken ?? null, input.ip ?? null],
    );
    return (await getDevice(existing.id))!;
  }

  const r = await one<{ id: string }>(
    `INSERT INTO devices
       (machine_id, user_id, name, platform, transport, push_token, last_ip, push_enabled, online, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,now())
     RETURNING id`,
    [input.machineId, input.userId, input.name, input.platform,
     input.transport ?? 'ws', input.pushToken ?? null, input.ip ?? null],
  );
  return (await getDevice(r!.id))!;
}

export async function touchDevice(id: string, online: boolean) {
  await run('UPDATE devices SET last_seen_at = now(), online = $2 WHERE id = $1', [id, online]);
}

export async function touch(id: string) {
  await run('UPDATE devices SET last_seen_at = now() WHERE id = $1', [id]);
}

/** WS 握手成功时调用。在线标记只有这里会置 true */
export async function markOnline(id: string) {
  await run('UPDATE devices SET last_seen_at = now(), online = true WHERE id = $1', [id]);
}

export async function markOfflineHint(id: string) {
  await run('UPDATE devices SET last_seen_at = now(), online = false WHERE id = $1', [id]);
}

export async function renameDevice(id: string, userId: string, name: string) {
  await run('UPDATE devices SET name = $3 WHERE id = $1 AND user_id = $2', [id, userId, name]);
}

/** 锁定记原因，解锁清掉；system 解锁不查 PIN 靠的就是这个原因值 */
export async function setLocked(
  id: string, locked: boolean, reason?: 'manual' | 'system',
): Promise<Device | undefined> {
  await run(
    `UPDATE devices
        SET locked = $2,
            lock_reason = CASE WHEN $2 THEN COALESCE($3, 'manual') ELSE NULL END
      WHERE id = $1`,
    [id, locked, reason ?? null],
  );
  return getDevice(id);
}

export async function setLastIp(id: string, ip: string | null) {
  await run('UPDATE devices SET last_ip = $2 WHERE id = $1', [id, ip]);
}

export async function setPushEnabled(id: string, userId: string, enabled: boolean) {
  await run('UPDATE devices SET push_enabled = $3 WHERE id = $1 AND user_id = $2', [id, userId, enabled]);
}

export async function deleteDevice(id: string, userId: string) {
  await run('DELETE FROM devices WHERE id = $1 AND user_id = $2', [id, userId]);
}

export async function sweepOffline(): Promise<Array<{ id: string; user_id: string }>> {
  return rows<{ id: string; user_id: string }>(
    `UPDATE devices SET online = false
      WHERE online = true AND last_seen_at < now() - interval '3 minutes'
      RETURNING id, user_id`,
  );
}
