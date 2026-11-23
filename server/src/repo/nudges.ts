import type { Nudge, NudgeChannel, NudgeLevel } from '../../../shared/types.js';
import { env } from '../env.js';
import { log } from '../log.js';
import { rows, toDt, toMs, tx, type Tx } from '../db.js';

interface NudgeRow {
  id: number;
  user_id: string;
  pursuit_id: string;
  device_id: string | null;
  fire_key: string;
  at: Date;
  level: number;
  channel: string;
  reason: string;
  state: string;
  attempts: number;
}

export interface PendingNudge extends Nudge {
  device_id: string | null;
  fire_key: string;
  attempts: number;
}

function mapNudge(r: NudgeRow): Nudge {
  return {
    id: r.id,
    pursuitId: r.pursuit_id,
    userId: r.user_id,
    at: toMs(r.at)!,
    level: r.level as NudgeLevel,
    channel: r.channel as NudgeChannel,
    reason: r.reason,
  };
}

export async function createNudge(
  userId: string, pursuitId: string, deviceId: string | null,
  level: NudgeLevel, channel: NudgeChannel, reason: string, fireKey: string,
): Promise<Nudge | null> {
  return tx(async (q) => {
    // device_id 为 NULL 时唯一约束不生效，必须自己查一次才能保证幂等
    if (deviceId === null) {
      const hit = await q.one<{ id: number }>(
        `SELECT id FROM nudges WHERE pursuit_id = $1 AND device_id IS NULL AND fire_key = $2`,
        [pursuitId, fireKey],
      );
      if (hit) return null;
    }
    const r = await q.one<NudgeRow>(
      `INSERT INTO nudges (user_id, pursuit_id, device_id, fire_key, level, channel, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pursuit_id, device_id, fire_key) DO NOTHING
       RETURNING *`,
      [userId, pursuitId, deviceId, fireKey, level, channel, reason],
    );
    return r ? mapNudge(r) : null;
  });
}

export async function takePending(limit: number): Promise<Nudge[]> {
  const retryAfter = new Date(Date.now() - env.DELIVERY_RETRY_MS);
  const rs = await rows<NudgeRow>(
    `SELECT * FROM nudges
      WHERE state = 'pending' AND (last_attempt_at IS NULL OR last_attempt_at < $2)
      ORDER BY at ASC, id ASC LIMIT $1`,
    [Math.max(1, Math.min(limit, 500)), retryAfter],
  );
  return rs.map((r) => ({
    ...mapNudge(r),
    device_id: r.device_id,
    fire_key: r.fire_key,
    attempts: r.attempts,
  }));
}

export async function markDelivered(id: number): Promise<void> {
  await tx(async (q) => {
    await q.run(
      `UPDATE nudges
          SET state = 'delivered', delivered_at = now(), attempts = attempts + 1,
              last_error = NULL, last_attempt_at = now()
        WHERE id = $1 AND state = 'pending'`,
      [id],
    );
  });
}

export async function markFailed(id: number, error: string): Promise<void> {
  await tx(async (q) => {
    const attempts = await q.scalar<number>(
      `UPDATE nudges SET attempts = attempts + 1, last_error = $2, last_attempt_at = now()
        WHERE id = $1 AND state = 'pending' RETURNING attempts`,
      [id, error.slice(0, 300)],
    );
    if (attempts !== undefined && attempts >= env.DELIVERY_MAX_ATTEMPTS) {
      log.warn('nudges', `投递 #${id} 已重试 ${attempts} 次，等待 sweepStale 回收`);
    }
  });
}

export async function markAcked(id: number, action: string): Promise<void> {
  await tx(async (q) => {
    await q.run(
      `UPDATE nudges
          SET state = 'acked', acked_at = now(), ack_action = $2,
              attempts = attempts + 1, last_attempt_at = now()
        WHERE id = $1 AND state <> 'acked'`,
      [id, action],
    );
  });
}

export async function countStrongToday(userId: string): Promise<number> {
  const n = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM nudges
      WHERE user_id = $1 AND level >= 4 AND at >= date_trunc('day', now())`,
    [userId],
  );
  return n[0]?.n ?? 0;
}

export async function listMissed(userId: string, afterMs: number): Promise<Nudge[]> {
  const rs = await rows<NudgeRow>(
    `SELECT * FROM nudges
      WHERE user_id = $1 AND state = 'pending' AND at <= $2
      ORDER BY at ASC, id ASC LIMIT 50`,
    [userId, toDt(afterMs)],
  );
  return rs.map(mapNudge);
}

export async function sweepStale(): Promise<number> {
  return tx(async (q) => {
    const cutoff = new Date(Date.now() - env.DELIVERY_RETRY_MS);
    const retried = await q.run(
      `DELETE FROM nudges
        WHERE state = 'pending' AND attempts >= $2 AND last_attempt_at < $1`,
      [cutoff, env.DELIVERY_MAX_ATTEMPTS],
    );
    const acked = await q.run(
      `DELETE FROM nudges WHERE state = 'acked' AND acked_at < now() - interval '7 days'`,
    );
    return retried + acked;
  });
}
