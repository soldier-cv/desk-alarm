import type { Step, StepState } from '../../../shared/types.js';
import { rows, toMs, tx, type Tx } from '../db.js';

export interface StepRow {
  id: string;
  pursuit_id: string;
  text: string;
  position: number;
  state: string;
  done_at: Date | null;
  created_at: Date;
}

export function mapStep(r: StepRow): Step {
  return {
    id: r.id,
    pursuitId: r.pursuit_id,
    text: r.text,
    position: r.position,
    state: (r.state === 'done' || r.state === 'doing' ? r.state : 'todo') as StepState,
    doneAt: toMs(r.done_at),
    createdAt: toMs(r.created_at)!,
  };
}

async function bumpPursuit(q: Tx, pursuitId: string, userId: string): Promise<void> {
  await q.run(
    `UPDATE pursuits
        SET version = version + 1, updated_at = now(), last_activity_at = now()
      WHERE id = $1 AND user_id = $2`,
    [pursuitId, userId],
  );
}

export async function listSteps(pursuitId: string, userId: string): Promise<Step[]> {
  const rs = await rows<StepRow>(
    'SELECT * FROM steps WHERE pursuit_id = $1 AND user_id = $2 ORDER BY position ASC, created_at ASC',
    [pursuitId, userId],
  );
  return rs.map(mapStep);
}

export async function addStep(pursuitId: string, userId: string, text: string): Promise<Step> {
  const r = await tx(async (q) => {
    const owned = await q.one<{ id: string }>(
      'SELECT id FROM pursuits WHERE id = $1 AND user_id = $2', [pursuitId, userId],
    );
    if (!owned) throw new Error('NOT_FOUND');
    const pos = await q.scalar<number>(
      'SELECT COALESCE(MAX(position) + 1, 0) FROM steps WHERE pursuit_id = $1', [pursuitId],
    );
    const inserted = await q.one<StepRow>(
      `INSERT INTO steps (pursuit_id, user_id, text, position)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [pursuitId, userId, text.trim(), pos ?? 0],
    );
    await bumpPursuit(q, pursuitId, userId);
    return inserted;
  });
  if (!r) throw new Error('INSERT_FAILED');
  return mapStep(r);
}

export async function updateStep(
  stepId: string, userId: string, patch: { text?: string; state?: StepState },
): Promise<Step | null> {
  const r = await tx(async (q) => {
    const cur = await q.one<StepRow & { pursuit_id: string }>(
      'SELECT * FROM steps WHERE id = $1 AND user_id = $2', [stepId, userId],
    );
    if (!cur) return null;
    const text = patch.text === undefined ? cur.text : patch.text.trim();
    const state = patch.state ?? cur.state;
    const doneAt = state === 'done'
      ? (cur.done_at ?? new Date())
      : null;
    const updated = await q.one<StepRow>(
      `UPDATE steps SET text = $2, state = $3, done_at = $4
        WHERE id = $1 AND user_id = $5 RETURNING *`,
      [stepId, text, state, doneAt, userId],
    );
    if (updated) await bumpPursuit(q, cur.pursuit_id, userId);
    return updated;
  });
  return r ? mapStep(r) : null;
}

export async function deleteStep(stepId: string, userId: string): Promise<boolean> {
  return tx(async (q) => {
    const cur = await q.one<{ pursuit_id: string }>(
      'SELECT pursuit_id FROM steps WHERE id = $1 AND user_id = $2', [stepId, userId],
    );
    if (!cur) return false;
    const n = await q.run('DELETE FROM steps WHERE id = $1 AND user_id = $2', [stepId, userId]);
    if (n > 0) await bumpPursuit(q, cur.pursuit_id, userId);
    return n > 0;
  });
}

export async function insertSteps(
  q: Tx, pursuitId: string, userId: string, texts: string[],
): Promise<void> {
  if (texts.length === 0) return;
  const start = await q.scalar<number>(
    'SELECT COALESCE(MAX(position) + 1, 0) FROM steps WHERE pursuit_id = $1', [pursuitId],
  );
  const base = start ?? 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]?.trim();
    if (!t) continue;
    await q.run(
      `INSERT INTO steps (pursuit_id, user_id, text, position) VALUES ($1,$2,$3,$4)`,
      [pursuitId, userId, t, base + i],
    );
  }
}
