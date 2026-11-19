import { createHash } from 'node:crypto';
import { one, rows, run } from '../db.js';

export type AgentScope = 'read' | 'write';

export interface AgentToken {
  id: string;
  name: string;
  prefix: string;
  scope: AgentScope;
  machineId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  machine_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function toToken(r: Row): AgentToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scope: r.scope as AgentScope,
    machineId: r.machine_id,
    createdAt: new Date(r.created_at).getTime(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : null,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function listTokens(userId: string): Promise<AgentToken[]> {
  const r = await rows<Row>(
    `SELECT * FROM agent_tokens
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`, [userId],
  );
  return r.map(toToken);
}

export async function createToken(input: {
  userId: string;
  name: string;
  machineId: string | null;
  scope: AgentScope;
  days: number;
}): Promise<{ token: AgentToken; plain: string }> {
  const plain = `dka_${createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${input.userId}`)
    .digest('base64url')}`;
  const r = await one<{ id: string }>(
    `INSERT INTO agent_tokens
       (user_id, machine_id, name, token_hash, prefix, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)
     RETURNING id`,
    [input.userId, input.machineId, input.name, hashToken(plain),
     plain.slice(0, 12), input.scope, String(input.days)],
  );
  return { token: (await getToken(r!.id, input.userId))!, plain };
}

export async function getToken(id: string, userId: string): Promise<AgentToken | undefined> {
  const r = await one<Row>(
    'SELECT * FROM agent_tokens WHERE id = $1 AND user_id = $2', [id, userId],
  );
  return r ? toToken(r) : undefined;
}

export async function revokeToken(id: string, userId: string): Promise<boolean> {
  const n = await run(
    `UPDATE agent_tokens SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [id, userId],
  );
  return n > 0;
}

/** resolveSession 用。返回 user_id / machine_id / scope */
export async function resolveToken(plain: string): Promise<{
  userId: string; machineId: string | null; scope: AgentScope; id: string;
} | null> {
  const r = await one<{
    id: string; user_id: string; machine_id: string | null; scope: string; expires_at: Date | null;
  }>(
    `SELECT id, user_id, machine_id, scope, expires_at
       FROM agent_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(plain)],
  );
  if (!r) return null;
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;
  return { id: r.id, userId: r.user_id, machineId: r.machine_id, scope: r.scope as AgentScope };
}

export async function touchToken(id: string) {
  await run('UPDATE agent_tokens SET last_used_at = now() WHERE id = $1', [id]);
}
