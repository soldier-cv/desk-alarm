import {
  defaultDueMs, importanceForStrength, strengthOfImportance,
  type Commitment, type CreatePursuitRequest, type EntryKind, type Importance,
  type Pursuit, type PursuitContext, type PursuitNature, type PursuitStatus, type RecurrenceRule,
  type Step, type UpdatePursuitRequest,
} from '../../../shared/types.js';
import { one, rows, toDt, toMs, tx, type Tx } from '../db.js';
import { insertSteps, mapStep, type StepRow } from './steps.js';

interface PursuitRow {
  id: string;
  user_id: string;
  text: string;
  note: string | null;
  kind: string;
  url: string | null;
  path: string | null;
  nature: string;
  importance: number;
  due_at: Date | null;
  recurrence: RecurrenceRule | null;
  context: PursuitContext | null;
  commitment: Commitment | null;
  status: string;
  importance_sort: number;
  source: string;
  version: number;
  last_activity_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function mapPursuit(row: any, steps: Step[], deviceIds: string[], nowMs: number): Pursuit {
  const r = row as PursuitRow;
  const lastActivityAt = toMs(r.last_activity_at) ?? nowMs;
  const progress = steps.length > 0
    ? steps.filter((s) => s.state === 'done').length / steps.length
    : 0;
  const p: Pursuit = {
    id: r.id,
    userId: r.user_id,
    text: r.text,
    note: r.note,
    kind: r.kind as EntryKind,
    url: r.url,
    path: r.path,
    nature: r.nature as PursuitNature,
    strength: r.importance >= 3 ? 'strong' : 'weak',
    importance: r.importance as Importance,
    dueAt: toMs(r.due_at),
    recurrence: r.recurrence ?? null,
    context: r.context ?? null,
    commitment: r.commitment ?? null,
    status: r.status as PursuitStatus,
    importanceSort: r.importance_sort,
    version: r.version,
    createdAt: toMs(r.created_at)!,
    updatedAt: toMs(r.updated_at)!,
    completedAt: toMs(r.completed_at),
    lastActivityAt,
    progress,
    stalenessMs: Math.max(0, nowMs - lastActivityAt),
    weight: 0,
    steps,
    deviceIds,
    source: r.source === 'mcp' ? 'mcp' : 'app',
  };
  return p;
}

async function hydrate(rs: PursuitRow[], userId: string, nowMs: number): Promise<Pursuit[]> {
  if (rs.length === 0) return [];
  const ids = rs.map((r) => r.id);
  const stepRows = await rows<StepRow>(
    `SELECT * FROM steps WHERE pursuit_id = ANY($1::text[]) AND user_id = $2
      ORDER BY pursuit_id ASC, position ASC, created_at ASC`,
    [ids, userId],
  );
  const deviceRows = await rows<{ pursuit_id: string; device_id: string }>(
    'SELECT pursuit_id, device_id FROM pursuit_devices WHERE pursuit_id = ANY($1::text[])',
    [ids],
  );
  const stepsBy = new Map<string, ReturnType<typeof mapStep>[]>();
  for (const s of stepRows) {
    if (!stepsBy.has(s.pursuit_id)) stepsBy.set(s.pursuit_id, []);
    stepsBy.get(s.pursuit_id)!.push(mapStep(s));
  }
  const devicesBy = new Map<string, string[]>();
  for (const d of deviceRows) {
    if (!devicesBy.has(d.pursuit_id)) devicesBy.set(d.pursuit_id, []);
    devicesBy.get(d.pursuit_id)!.push(d.device_id);
  }
  return rs.map((r) => mapPursuit(r, stepsBy.get(r.id) ?? [], devicesBy.get(r.id) ?? [], nowMs));
}

export async function listPursuits(
  userId: string, opts?: { status?: PursuitStatus },
): Promise<Pursuit[]> {
  const sql = opts?.status
    ? 'SELECT * FROM pursuits WHERE user_id = $1 AND status = $2 ORDER BY importance_sort ASC, created_at DESC'
    : 'SELECT * FROM pursuits WHERE user_id = $1 ORDER BY importance_sort ASC, created_at DESC';
  const rs = await rows<PursuitRow>(sql, opts?.status ? [userId, opts.status] : [userId]);
  return hydrate(rs, userId, Date.now());
}

export async function getPursuit(id: string, userId: string): Promise<Pursuit | null> {
  const r = await one<PursuitRow>(
    'SELECT * FROM pursuits WHERE id = $1 AND user_id = $2', [id, userId],
  );
  if (!r) return null;
  return (await hydrate([r], userId, Date.now()))[0] ?? null;
}

export async function getPursuitVersion(id: string, userId: string): Promise<number | null> {
  const r = await one<{ version: number }>(
    'SELECT version FROM pursuits WHERE id = $1 AND user_id = $2', [id, userId],
  );
  return r?.version ?? null;
}

async function replaceDevices(q: Tx, pursuitId: string, userId: string, deviceIds: string[]): Promise<void> {
  await q.run('DELETE FROM pursuit_devices WHERE pursuit_id = $1', [pursuitId]);
  for (const deviceId of deviceIds) {
    const owned = await q.one<{ id: string }>(
      'SELECT id FROM devices WHERE id = $1 AND user_id = $2', [deviceId, userId],
    );
    if (!owned) continue;
    await q.run(
      `INSERT INTO pursuit_devices (pursuit_id, device_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [pursuitId, deviceId],
    );
  }
}

export async function createPursuit(userId: string, req: CreatePursuitRequest): Promise<Pursuit> {
  const importance = req.strength ? importanceForStrength(req.strength) : req.importance ?? 1;
  const dueAt = toDt(req.dueAt) ?? new Date(defaultDueMs(strengthOfImportance(importance), Date.now()));
  const id = await tx(async (q) => {
    const r = await q.one<{ id: string }>(
      `INSERT INTO pursuits
         (user_id, text, note, kind, url, path, nature, importance, due_at,
          recurrence, context, commitment, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [userId,
       req.text.trim(),
       req.note?.trim() || null,
       (req.kind ?? 'text') as EntryKind,
       req.url ?? null,
       req.path ?? null,
       (req.nature ?? 'one_off') as PursuitNature,
       importance,
       dueAt,
       req.recurrence ?? null,
       req.context ?? null,
       req.commitment ?? null,
       (req.status ?? 'active') as PursuitStatus,
       'app'],
    );
    if (!r) throw new Error('INSERT_FAILED');
    if (req.steps?.length) await insertSteps(q, r.id, userId, req.steps);
    if (req.deviceIds?.length) await replaceDevices(q, r.id, userId, req.deviceIds);
    return r.id;
  });
  return (await getPursuit(id, userId))!;
}

/** 克隆：复制内容，不复制完成状态、截止、跟进历史和步骤完成状态 */
export async function clonePursuit(id: string, userId: string): Promise<Pursuit | null> {
  const src = await getPursuit(id, userId);
  if (!src) return null;
  const newId = await tx(async (q) => {
    const r = await q.one<{ id: string }>(
      `INSERT INTO pursuits
         (user_id, text, note, kind, url, path, nature, importance, due_at,
          recurrence, context, commitment, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,'active',$12)
       RETURNING id`,
      [userId, src.text, src.note, src.kind, src.url, src.path, src.nature,
        src.importance, src.recurrence, src.context, src.commitment, src.source],
    );
    if (!r) throw new Error('INSERT_FAILED');
    if (src.steps.length) {
      await insertSteps(q, r.id, userId, src.steps.map((s) => s.text));
    }
    if (src.deviceIds.length) await replaceDevices(q, r.id, userId, src.deviceIds);
    return r.id;
  });
  return (await getPursuit(newId, userId))!;
}

export async function updatePursuit(
  id: string, userId: string, req: UpdatePursuitRequest,
): Promise<Pursuit | null> {
  const changed = await tx(async (q) => {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (req.text !== undefined) add('text', req.text.trim());
    if ('note' in req) add('note', req.note?.trim() || null);
    if (req.strength !== undefined) add('importance', importanceForStrength(req.strength));
    else if (req.importance !== undefined) add('importance', req.importance);
    if (req.nature !== undefined) add('nature', req.nature);
    if ('dueAt' in req) add('due_at', toDt(req.dueAt));
    if ('recurrence' in req) add('recurrence', req.recurrence);
    if ('context' in req) add('context', req.context);
    if ('commitment' in req) add('commitment', req.commitment);
    if (req.status !== undefined) {
      add('status', req.status);
      if (req.status === 'done') add('completed_at', new Date());
    }
    sets.push('version = version + 1', 'updated_at = now()');

    params.push(userId, req.version);
    const n = await q.run(
      `UPDATE pursuits SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $${params.length - 1} AND version = $${params.length}`,
      params,
    );
    if (n === 0) return false;
    if (req.deviceIds !== undefined) await replaceDevices(q, id, userId, req.deviceIds);
    return true;
  });
  if (!changed) return null;
  return getPursuit(id, userId);
}

export async function setStatus(
  id: string, userId: string, status: PursuitStatus,
): Promise<Pursuit | null> {
  const n = await tx((q) => q.run(
    `UPDATE pursuits
        SET status = $2,
            completed_at = CASE WHEN $2 = 'done' THEN now() WHEN $2 = 'archived' THEN completed_at ELSE NULL END,
            last_activity_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1 AND user_id = $3`,
    [id, status, userId],
  ));
  if (n === 0) return null;
  return getPursuit(id, userId);
}

export async function touchActivity(id: string, userId: string): Promise<void> {
  await tx((q) => q.run(
    'UPDATE pursuits SET last_activity_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2',
    [id, userId],
  ));
}

export async function setDueAt(id: string, userId: string, dueAt: number): Promise<void> {
  await tx((q) => q.run(
    `UPDATE pursuits SET due_at = $3, last_activity_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, toDt(dueAt)],
  ));
}

export async function setImportance(
  id: string, userId: string, importance: Importance,
): Promise<Pursuit | null> {
  const n = await tx((q) => q.run(
    `UPDATE pursuits SET importance = $3, last_activity_at = now(),
        version = version + 1, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, importance],
  ));
  if (n === 0) return null;
  return getPursuit(id, userId);
}

export async function deletePursuit(id: string, userId: string): Promise<boolean> {
  return tx((q) => q.run(
    'DELETE FROM pursuits WHERE id = $1 AND user_id = $2', [id, userId],
  ).then((n) => n > 0));
}

export async function listActiveUserIds(): Promise<string[]> {
  const rs = await rows<{ user_id: string }>(
    `SELECT DISTINCT p.user_id FROM pursuits p
       JOIN users u ON u.id = p.user_id
      WHERE p.status = 'active' AND u.disabled = false`,
  );
  return rs.map((r) => r.user_id);
}
