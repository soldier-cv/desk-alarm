/**
 * 投递 outbox。调度器只写，轮转器只投，两个循环互不阻塞。
 * 分工与背景见 docs/requirements.md「事务性发件箱」
 */
import type { Entry } from '../../../shared/types.js';
import { env } from '../env.js';
import { log } from '../log.js';
import { one, rows, run } from '../db.js';
import { getEntries, getEntry } from './entries.js';
import { transportFor } from '../transport/index.js';

interface PendingRow {
  id: number;
  entry_id: string;
  device_id: string;
  fire_key: string;
  transport: string | null;
  attempts: number;
}

/**
 * 生成一次触发的标识。同一次触发不管过多少轮、投递多少设备，
 * fire_key 都是同一个值，跨端去重就靠它。
 */
export function makeFireKey(entryId: string, firedAt: number): string {
  return `${entryId}:${firedAt}`;
}

/** 调度器到点时调用，只写 outbox，不投递 */
export function enqueueDelivery(entryId: string, deviceId: string, fireKey: string, firedAt: Date) {
  return run(
    `INSERT INTO deliveries (entry_id, device_id, fire_key, state, fired_at)
     VALUES ($1, $2, $3, 'pending', $4)
     ON CONFLICT (entry_id, device_id, fire_key) DO NOTHING`,
    [entryId, deviceId, fireKey, firedAt],
  );
}

/** 一次拉一批待投递的。按创建顺序，保证同一批提醒按时间先后到 */
export function takePending(limit = 200): Promise<PendingRow[]> {
  return rows<PendingRow>(
    `SELECT id, entry_id, device_id, fire_key, transport, attempts
       FROM deliveries
      WHERE state = 'pending'
      ORDER BY fired_at ASC, id ASC
      LIMIT $1`,
    [limit],
  );
}

export async function markDelivered(idsByTransport: Map<string, number[]>) {
  for (const [name, ids] of idsByTransport) {
    if (ids.length === 0) continue;
    await run(
      `UPDATE deliveries
          SET state = 'delivered', delivered_at = now(),
              transport = $2, attempts = attempts + 1, last_error = NULL
        WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
      [ids, name],
    );
  }
}

export async function markFailed(
  ids: number[], transportName: string, error: string, fatal: boolean,
) {
  if (ids.length === 0) return;
  await run(
    `UPDATE deliveries
        SET attempts = attempts + 1,
            last_error = $2,
            transport = $3,
            last_attempt_at = now()
      WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
    [ids, error.slice(0, 300), transportName],
  );
  // 明确失效的 token 没什么好重试的，标成 acked 之外的状态不好，
  // 直接删掉这行，设备下次上线会被提醒重新注册 token
  if (fatal) {
    await run(
      `DELETE FROM deliveries WHERE id = ANY($1::bigint[]) AND state = 'pending'`,
      [ids],
    );
  }
}

/**
 * 投递一批。返回成功和失败的 id 列表。
 * 失败不抛异常，写进 last_error 供排查
 */
export async function deliverBatch(batch: PendingRow[]): Promise<{
  ok: number; fail: number; byTransport: Record<string, number>;
}> {
  const okByTransport = new Map<string, number[]>();
  const failByTransport = new Map<string, { ids: number[]; error: string; fatal: boolean }>();
  const byTransport: Record<string, number> = {};

  // 同一批里同一条目会出现多次，先按 id 去重取一次
  const entryIds = [...new Set(batch.map((r) => r.entry_id))];
  const entries = new Map((await getEntries(entryIds)).map((e) => [e.id, e]));
  const transports = new Map(await Promise.all(
    [...new Set(batch.map((r) => r.device_id))].map(async (id) => [id, await deviceTransport(id)] as const),
  ));

  // 按通道分组，同一条通道的设备并发发
  const byT = new Map<string, PendingRow[]>();
  for (const row of batch) {
    const name = transports.get(row.device_id) ?? row.transport ?? 'ws';
    if (!byT.has(name)) byT.set(name, []);
    byT.get(name)!.push(row);
  }

  await Promise.all([...byT.entries()].map(async ([name, rowsOfT]) => {
    const t = transportFor(name as never);
    byTransport[name] = rowsOfT.length;

    await Promise.all(rowsOfT.map(async (row) => {
      const entry = entries.get(row.entry_id);
      if (!entry) return; // 条目被删了，外键级联会清掉这行

      // 条目已经被别的设备确认了，没必要再投
      if (entry.doneAt !== null) return;

      const r = await t.send(row.device_id, entry, entry.firedAt ?? Date.now());
      if (r.ok) {
        if (!okByTransport.has(name)) okByTransport.set(name, []);
        okByTransport.get(name)!.push(row.id);
      } else {
        const slot = failByTransport.get(name) ?? { ids: [], error: r.error ?? 'unknown', fatal: false };
        slot.ids.push(row.id);
        slot.error = r.error ?? slot.error;
        slot.fatal = slot.fatal || Boolean(r.fatal);
        failByTransport.set(name, slot);
      }
    }));
  }));

  for (const [name, slot] of failByTransport) {
    await markFailed(slot.ids, name, slot.error, slot.fatal);
  }
  await markDelivered(okByTransport);

  const ok = [...okByTransport.values()].reduce((n, ids) => n + ids.length, 0);
  const failed = [...failByTransport.values()].reduce((n, s) => n + s.ids.length, 0);
  return { ok, fail: failed, byTransport };
}

/** 设备通道缓存。设备数量是几十这个量级，超过上限就整体丢掉重建，不做 LRU */
const TRANSPORT_CACHE_MAX = 500;
let transportCache = new Map<string, string | null>();

async function deviceTransport(deviceId: string): Promise<string | null> {
  const cached = transportCache.get(deviceId);
  if (cached !== undefined) return cached;
  const r = await one<{ transport: string }>('SELECT transport FROM devices WHERE id = $1', [deviceId]);
  if (transportCache.size >= TRANSPORT_CACHE_MAX) transportCache = new Map();
  transportCache.set(deviceId, r?.transport ?? null);
  return r?.transport ?? null;
}

/** 设备改了通道或换了 token 之后要清缓存 */
export function invalidateTransport(deviceId: string) {
  transportCache.delete(deviceId);
}

/** 给设备注册 push token。通道取这台设备自己的，不能信调用方会话里的 */
export async function setPushToken(deviceId: string, transport: string | null, token: string | null) {
  await run(
    `UPDATE devices SET transport = COALESCE($2, transport), push_token = $3 WHERE id = $1`,
    [deviceId, transport, token],
  );
  invalidateTransport(deviceId);
}

/** 放弃重试太久的，把机会留给设备上线时的 missed 补发 */
export async function sweepStale() {
  const cutoff = new Date(Date.now() - env.DELIVERY_RETRY_MS);
  const n = await run(
    `DELETE FROM deliveries
      WHERE state = 'pending'
        AND attempts >= $2
        AND last_attempt_at < $1`,
    [cutoff, env.DELIVERY_MAX_ATTEMPTS],
  );
  if (n > 0) log.warn('outbox', `${n} 条投递重试超时，放弃并留给补发`);
}

/* ------------------------------------------------------- 跨端去重 */

/** 有没有别的设备已经确认过这条提醒 */
export async function ackedElsewhere(entryId: string, exceptDeviceId: string): Promise<string | null> {
  const r = await one<{ device_id: string }>(
    `SELECT device_id FROM deliveries
      WHERE entry_id = $1 AND state = 'acked' AND device_id <> $2
      ORDER BY acked_at DESC NULLS LAST LIMIT 1`,
    [entryId, exceptDeviceId],
  );
  return r?.device_id ?? null;
}

export async function markAcked(entryId: string, deviceId: string, action: string) {
  await run(
    `UPDATE deliveries
        SET state = 'acked', acked_at = now(), ack_action = $3,
            attempts = attempts + 1, last_attempt_at = now()
      WHERE entry_id = $1 AND device_id = $2 AND state <> 'acked'`,
    [entryId, deviceId, action],
  );
}

/**
 * 设备上线时补发的漏掉的提醒。
 * 判据是 fire_key 对不上当前这次触发：说明已重排过，或重复规则已排了下一次
 */
export async function findMissed(deviceId: string): Promise<Array<{
  entry: Entry; firedAt: number; lateByMs: number;
}>> {
  const cutoff = new Date(Date.now() - env.MISSED_AFTER_MS);
  const pending = await rows<{ id: number; entry_id: string; fire_key: string; fired_at: Date }>(
    `SELECT d.id, d.entry_id, d.fire_key, d.fired_at
       FROM deliveries d
       JOIN entries e ON e.id = d.entry_id
      WHERE d.device_id = $1
        AND d.state = 'pending'
        AND d.fired_at <= $2
        AND e.done_at IS NULL
        AND e.fired_at IS NOT NULL
      ORDER BY d.fired_at ASC
      LIMIT 50`,
    [deviceId, cutoff],
  );

  const out: Array<{ entry: Entry; firedAt: number; lateByMs: number }> = [];
  const stale: number[] = [];

  for (const r of pending) {
    const entry = await getEntry(r.entry_id);
    if (!entry) continue;

    const currentKey = makeFireKey(entry.id, entry.firedAt ?? 0);
    if (currentKey !== r.fire_key) {
      stale.push(r.id);
      continue;
    }
    const firedAt = new Date(r.fired_at).getTime();
    out.push({ entry, firedAt, lateByMs: Date.now() - firedAt });
  }

  if (stale.length > 0) {
    await run(`DELETE FROM deliveries WHERE id = ANY($1::bigint[])`, [stale]);
  }
  return out;
}

/** 清理已完成条目的投递记录，7 天后 */
export async function purgeSettled() {
  await run(`DELETE FROM deliveries WHERE state = 'acked' AND acked_at < now() - interval '7 days'`);
}
