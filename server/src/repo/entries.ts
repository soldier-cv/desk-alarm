import type {
  AckAction, CreateEntryRequest, Dismissal, Entry, EntryKind, EntryStatus,
  RepeatRule, Strength, UpdateEntryRequest,
} from '../../../shared/types.js';
import { one, rows, run, toDt, toMs, tx, type Tx } from '../db.js';
import { makeFireKey, enqueueDelivery } from './deliveries.js';

interface Row {
  id: string;
  text: string;
  kind: string;
  url: string | null;
  path: string | null;
  note: string | null;
  remind_at: Date | null;
  repeat: string;
  strength: string;
  bypass_quiet: boolean;
  source: string;
  fired_at: Date | null;
  done_at: Date | null;
  done_device: string | null;
  snooze_count: number;
  dismiss_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * status 读时推导，不入库。重复提醒触发后同时有 fired_at 和更大的 remind_at，
 * 这时不算 missed：只有「响过了、没处理、也没排下一次」才算漏掉
 */
export function deriveStatus(r: Row): EntryStatus {
  if (r.done_at) return 'done';
  if (r.remind_at === null) return 'inbox';
  if (r.fired_at && r.remind_at.getTime() <= r.fired_at.getTime()) return 'missed';
  return 'pending';
}

function toEntry(r: Row, devices: string[]): Entry {
  return {
    id: r.id,
    text: r.text,
    kind: r.kind as EntryKind,
    url: r.url,
    path: r.path,
    note: r.note,
    remindAt: toMs(r.remind_at),
    repeat: r.repeat as RepeatRule,
    status: deriveStatus(r),
    strength: (r.strength as Strength) ?? 'strong',
    bypassQuiet: !!r.bypass_quiet,
    hard: !!r.bypass_quiet, // 兼容旧客户端的字段名
    firedAt: toMs(r.fired_at),
    doneAt: toMs(r.done_at),
    doneDevice: r.done_device,
    snoozeCount: r.snooze_count,
    dismissCount: r.dismiss_count,
    source: r.source as 'app' | 'mcp',
    devices,
    version: r.version,
    createdAt: toMs(r.created_at)!,
    updatedAt: toMs(r.updated_at)!,
  };
}

/** 没有 scope 行 = 推给全部设备，对外统一表达成 ['*'] */
async function targetsOf(entryId: string): Promise<string[]> {
  const r = await rows<{ device_id: string }>(
    'SELECT device_id FROM entry_devices WHERE entry_id = $1 ORDER BY device_id', [entryId],
  );
  return r.length === 0 ? ['*'] : r.map((x) => x.device_id);
}

export async function getEntry(id: string): Promise<Entry | undefined> {
  const r = await one<Row>('SELECT * FROM entries WHERE id = $1', [id]);
  if (!r) return undefined;
  return toEntry(r, await targetsOf(id));
}

/** 批量取，避免列表页 N+1 */
export async function getEntries(ids: string[]): Promise<Entry[]> {
  if (ids.length === 0) return [];
  const rs = await rows<Row>('SELECT * FROM entries WHERE id = ANY($1::text[])', [ids]);
  const scopes = await rows<{ entry_id: string; device_id: string }>(
    'SELECT entry_id, device_id FROM entry_devices WHERE entry_id = ANY($1::text[]) ORDER BY device_id',
    [ids],
  );
  const map = new Map<string, string[]>();
  for (const s of scopes) {
    if (!map.has(s.entry_id)) map.set(s.entry_id, []);
    map.get(s.entry_id)!.push(s.device_id);
  }
  return rs.map((r) => toEntry(r, map.get(r.id) ?? ['*']));
}

/* ---------------------------------------------------------------- 读 */

export type ListView = 'today' | 'upcoming' | 'inbox' | 'all' | 'done';

export async function listEntries(
  view: ListView = 'all', limit?: number,
): Promise<Entry[]> {
  const cap = Math.min(limit ?? 200, 1000);
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(tomorrow.getTime() + 7 * 86400_000);

  let where: string;
  let params: unknown[] = [];

  switch (view) {
    case 'today':
      where = `done_at IS NULL AND ((remind_at IS NOT NULL AND remind_at < $1) OR remind_at IS NULL)`;
      params = [tomorrow];
      break;
    case 'upcoming':
      where = `done_at IS NULL AND fired_at IS NULL AND remind_at >= $1 AND remind_at <= $2`;
      params = [tomorrow, weekEnd];
      break;
    case 'inbox':
      where = 'done_at IS NULL AND remind_at IS NULL';
      break;
    case 'done':
      where = 'done_at IS NOT NULL';
      break;
    default:
      where = 'done_at IS NULL';
  }

  params.push(cap);
  const rs = await rows<Row>(
    `SELECT * FROM entries WHERE ${where}
      ORDER BY (remind_at IS NULL), remind_at ASC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const ids = rs.map((r) => r.id);
  const scopes = ids.length === 0 ? [] : await rows<{ entry_id: string; device_id: string }>(
    'SELECT entry_id, device_id FROM entry_devices WHERE entry_id = ANY($1::text[]) ORDER BY device_id',
    [ids],
  );
  const map = new Map<string, string[]>();
  for (const s of scopes) {
    if (!map.has(s.entry_id)) map.set(s.entry_id, []);
    map.get(s.entry_id)!.push(s.device_id);
  }
  return rs.map((r) => toEntry(r, map.get(r.id) ?? ['*']));
}

export async function searchEntries(q: string, limit = 30): Promise<Entry[]> {
  const term = q.trim();
  if (!term) return [];
  // 用 to_tsvector 建了 GIN 索引，模糊匹配直接用 ILIKE 也够用，
  // 这里两者结合：ILIKE 保证短查询和中文也能命中
  const rs = await rows<Row>(
    `SELECT * FROM entries
      WHERE done_at IS NULL AND (text ILIKE $1 OR note ILIKE $1 OR path ILIKE $1)
      ORDER BY remind_at NULLS LAST, created_at DESC
      LIMIT $2`,
    [`%${term}%`, Math.min(limit, 200)],
  );
  return Promise.all(rs.map((r) => getEntry(r.id).then((e) => e!)));
}

/* ---------------------------------------------------------------- 写 */

function toEpoch(v: number | string | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const ms = toDt(v);
  return ms;
}

/** 粘贴链接识别成 link，Windows 路径识别成 path */
function guessKind(text: string): EntryKind {
  const t = text.trim();
  if (/^(https?:\/\/|www\.)\S+/i.test(t)) return 'link';
  if (/^[a-zA-Z]:\\|^\/\//.test(t)) return 'path';
  return 'text';
}

export async function createEntry(req: CreateEntryRequest, opts: {
  source?: 'app' | 'mcp';
  /** 幂等键。agent 重试同一个键不会造出两条 */
  idempotencyKey?: string;
} = {}): Promise<Entry> {
  if (opts.idempotencyKey) {
    const hit = await one<{ entry_id: string }>(
      'SELECT entry_id FROM idempotency WHERE key = $1', [opts.idempotencyKey],
    );
    if (hit) return (await getEntry(hit.entry_id))!;
  }

  const remindAt = toEpoch(req.remindAt);
  const kind: EntryKind = req.kind ?? guessKind(req.text);
  // 强度和静音豁免正交。这里把没定时的默认成 weak：
  // 收集箱里的东西本来就不该响铃
  const strength: Strength = req.strength ?? (remindAt === null ? 'weak' : 'strong');
  const text = req.text.trim();

  const id = await tx(async (q) => {
    const r = await q.one<{ id: string }>(
      `INSERT INTO entries
         (text, kind, url, path, note, remind_at, repeat, strength, bypass_quiet, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [text, kind, req.url ?? null, req.path ?? null,
       req.note?.trim() || null, remindAt, req.repeat ?? 'none', strength,
       req.bypassQuiet ? true : false, (opts.source ?? 'app') as 'app' | 'mcp'],
    );
    if (!r) throw new Error('INSERT 没返回 id');

    if (req.devices && req.devices.length > 0 && !req.devices.includes('*')) {
      for (const deviceId of req.devices) {
        // 逐个插。直接把数组当一个参数传进去会插出一行 device_id='[a,b]'
        await q.run(
          `INSERT INTO entry_devices (entry_id, device_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [r.id, deviceId],
        );
      }
    }
    if (opts.idempotencyKey) {
      await q.run('INSERT INTO idempotency (key, entry_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [opts.idempotencyKey, r.id]);
    }
    return r.id;
  });

  return (await getEntry(id))!;
}

export class VersionConflict extends Error {
  constructor(public current: Entry) { super('条目已被其它设备修改'); }
}

export async function updateEntry(id: string, req: UpdateEntryRequest): Promise<Entry> {
  const cur = await getEntry(id);
  if (!cur) throw new Error('NOT_FOUND');
  if (req.version !== undefined && req.version !== cur.version) {
    throw new VersionConflict(cur);
  }

  const remindAt = 'remindAt' in req ? toEpoch(req.remindAt) : toDt(cur.remindAt);
  // 改了时间就当没响过，重新排进调度队列
  const timeChanged = (toMs(remindAt) ?? null) !== cur.remindAt;

  await tx(async (q) => {
    await q.run(
      `UPDATE entries SET
         text = $2, note = $3, remind_at = $4, repeat = $5, strength = $6,
         bypass_quiet = $7, fired_at = $8, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [id,
       req.text?.trim() ?? cur.text,
       'note' in req ? (req.note?.trim() || null) : cur.note,
       remindAt,
       req.repeat ?? cur.repeat,
       req.strength ?? cur.strength,
       req.bypassQuiet === undefined ? cur.bypassQuiet : req.bypassQuiet,
       timeChanged ? null : toDt(cur.firedAt)],
    );
    if (req.devices) {
      await q.run('DELETE FROM entry_devices WHERE entry_id = $1', [id]);
      if (req.devices.length > 0 && !req.devices.includes('*')) {
        for (const d of req.devices) {
          await q.run(
            'INSERT INTO entry_devices (entry_id, device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [id, d],
          );
        }
      }
    }
  });

  return (await getEntry(id))!;
}

export async function deleteEntry(id: string) {
  await run('DELETE FROM entries WHERE id = $1', [id]);
}

/**
 * 确认。done / snooze 改条目，silence 只压掉这一次。幂等。
 * 返回值必须事务提交后回读：事务里走连接池读到的是提交前的旧值
 */
export async function ackEntry(
  id: string, action: AckAction, deviceName: string, snoozeToMs?: number,
): Promise<Entry> {
  await tx(async (q) => {
    const cur = await getEntry(id);
    if (!cur) throw new Error('NOT_FOUND');

    if (action === 'done') {
      if (cur.doneAt === null) {
        await q.run(
          `UPDATE entries SET done_at = now(), done_device = $2,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [id, deviceName],
        );
      }
    } else if (action === 'snooze' && snoozeToMs) {
      await q.run(
        `UPDATE entries SET remind_at = $2, fired_at = NULL,
           snooze_count = snooze_count + 1, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, toDt(snoozeToMs)],
      );
    }
    // silence 不动条目本身
  });

  // 提交之后再读，拿到的一定是最终状态
  const after = await getEntry(id);
  if (!after) throw new Error('NOT_FOUND');
  return after;
}

/* ------------------------------------------------------- 弱提示忽略 */

export async function dismissEntry(
  id: string, deviceId: string, deviceName: string, reason?: string,
): Promise<{ entry: Entry; dismissCount: number; suggestion: string | null }> {
  const result = await tx(async (q) => {
    const cur = await getEntry(id);
    if (!cur) throw new Error('NOT_FOUND');

    await q.run(
      `INSERT INTO dismissals (entry_id, device_id, device_name, reason) VALUES ($1,$2,$3,$4)`,
      [id, deviceId, deviceName, reason?.trim() || null],
    );
    const n = (await q.scalar<number>(
      'UPDATE entries SET dismiss_count = dismiss_count + 1, updated_at = now() WHERE id = $1 RETURNING dismiss_count',
      [id],
    )) ?? 0;

    // 忽略 2 次自动降级为弱提示。系统在替用户学习，
    // 不是每次都等用户自己去改
    if (n >= 2 && cur.strength === 'strong') {
      await q.run(
        `UPDATE entries SET strength = 'weak', version = version + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
    }
    return n;
  });

  const entry = (await getEntry(id))!;
  return {
    entry,
    dismissCount: result,
    suggestion: result >= 3
      ? `这条已经被忽略 ${result} 次了，要么删掉，要么改成弱提示`
      : result === 2
        ? '已自动降级为弱提示'
        : null,
  };
}

export async function listDismissals(limit = 100): Promise<Array<Dismissal & { text: string }>> {
  const rs = await rows<{
    id: number; entry_id: string; device_id: string; device_name: string;
    reason: string | null; at: Date; text: string;
  }>(
    `SELECT d.id, d.entry_id, d.device_id, d.device_name, d.reason, d.at, e.text
       FROM dismissals d JOIN entries e ON e.id = d.entry_id
      WHERE e.done_at IS NULL
      ORDER BY d.at DESC LIMIT $1`,
    [Math.min(limit, 500)],
  );
  return rs.map((r) => ({
    id: r.id,
    entryId: r.entry_id,
    deviceId: r.device_id,
    deviceName: r.device_name,
    reason: r.reason,
    at: toMs(r.at)!,
    text: r.text,
  }));
}

/** 被反复忽略的条目。这个视图是「强弱提示」整套设计真正的收益点 */
export async function listNeglected(minCount = 2): Promise<Entry[]> {
  const rs = await rows<Row>(
    `SELECT * FROM entries
      WHERE done_at IS NULL AND dismiss_count >= $1
      ORDER BY dismiss_count DESC, updated_at DESC LIMIT 50`,
    [minCount],
  );
  return Promise.all(rs.map((r) => getEntry(r.id).then((e) => e!)));
}

/* ------------------------------------------------------------ 调度器 */

export interface DueEntry {
  entry: Entry;
  targetIds: string[];
}

export async function findDue(limit = 50): Promise<DueEntry[]> {
  const rs = await rows<Row>(
    `SELECT * FROM entries
      WHERE fired_at IS NULL AND done_at IS NULL AND remind_at IS NOT NULL AND remind_at <= now()
      ORDER BY remind_at ASC LIMIT $1`,
    [limit],
  );
  const out: DueEntry[] = [];
  for (const r of rs) {
    const entry = await getEntry(r.id);
    if (!entry) continue;
    const ids = await resolveTargets(r.id);
    out.push({ entry, targetIds: ids });
  }
  return out;
}

async function resolveTargets(entryId: string): Promise<string[]> {
  const scoped = await rows<{ device_id: string }>(
    `SELECT d.device_id FROM entry_devices d
       JOIN devices dv ON dv.id = d.device_id
      WHERE d.entry_id = $1 AND dv.push_enabled`,
    [entryId],
  );
  if (scoped.length > 0) return scoped.map((r) => r.device_id);

  // 没有指定范围 = 全部开了推送的设备
  const all = await rows<{ id: string }>(
    'SELECT id FROM devices WHERE push_enabled ORDER BY id',
  );
  return all.map((r) => r.id);
}

/**
 * 写入 fired_at。全系统唯一决定「这条提醒响了」的地方。
 * 投递 outbox 同事务写入，两者不可能只成功一半
 */
export async function markFired(entry: Entry): Promise<{ entry: Entry; repeat: RepeatRule }> {
  const fireAt = new Date();
  let nextRemind: Date | null = toDt(entry.remindAt);

  if (entry.repeat !== 'none' && entry.remindAt !== null) {
    nextRemind = nextOccurrence(Math.max(entry.remindAt, fireAt.getTime()), entry.repeat);
  }

  await tx(async (q) => {
    if (nextRemind && entry.repeat !== 'none') {
      await q.run(
        `UPDATE entries SET fired_at = $2, remind_at = $3,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [entry.id, fireAt, nextRemind],
      );
    } else {
      await q.run(
        `UPDATE entries SET fired_at = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [entry.id, fireAt],
      );
    }

    const ids = await resolveTargets(entry.id);
    const key = makeFireKey(entry.id, fireAt.getTime());
    for (const deviceId of ids) {
      await q.run(
        `INSERT INTO deliveries (entry_id, device_id, fire_key, state, fired_at)
         VALUES ($1,$2,$3,'pending',$4)
         ON CONFLICT (entry_id, device_id, fire_key) DO NOTHING`,
        [entry.id, deviceId, key, fireAt],
      );
    }
  });

  return { entry: (await getEntry(entry.id))!, repeat: entry.repeat };
}

/**
 * 算下一次。月末要钳位：1 月 31 日加一个月应该落到 2 月最后一天，
 * 不能让 setMonth 溢出到 3 月 3 号
 */
export function nextOccurrence(from: number, rule: RepeatRule): Date {
  const d = new Date(from);
  switch (rule) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly': {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
      break;
    }
    default:
      return d;
  }
  return d;
}

export { makeFireKey, enqueueDelivery };
export type { Tx };
