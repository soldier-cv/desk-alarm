import type { Followup, FollowupAction, NudgeLevel } from '../../../shared/types.js';
import { rows, toMs, tx, type Tx } from '../db.js';

interface FollowupRow {
  id: number;
  pursuit_id: string;
  user_id: string;
  at: Date;
  level: number;
  action: string;
  note: string | null;
}

export function mapFollowup(r: FollowupRow): Followup {
  return {
    id: r.id,
    pursuitId: r.pursuit_id,
    userId: r.user_id,
    at: toMs(r.at)!,
    level: r.level as NudgeLevel,
    action: r.action as FollowupAction,
    note: r.note,
  };
}

export async function insertFollowup(
  q: Tx, pursuitId: string, userId: string, level: NudgeLevel,
  action: FollowupAction, note: string | null,
): Promise<Followup> {
  const r = await q.one<FollowupRow>(
    `INSERT INTO followups (user_id, pursuit_id, level, action, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, pursuitId, level, action, note?.trim() || null],
  );
  if (!r) throw new Error('INSERT_FAILED');
  return mapFollowup(r);
}

export async function recordFollowup(
  pursuitId: string, userId: string, level: NudgeLevel,
  action: FollowupAction, note: string | null,
): Promise<Followup> {
  return tx((q) => insertFollowup(q, pursuitId, userId, level, action, note));
}

export async function listFollowups(pursuitId: string, userId: string): Promise<Followup[]> {
  const rs = await rows<FollowupRow>(
    `SELECT * FROM followups WHERE pursuit_id = $1 AND user_id = $2 ORDER BY at DESC, id DESC`,
    [pursuitId, userId],
  );
  return rs.map(mapFollowup);
}
