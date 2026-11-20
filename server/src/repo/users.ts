/**
 * 用户与密码。密码哈希用 Node 内置 scrypt（随机盐 + 定长比较），
 * 不引入需要原生编译的依赖，各平台行为一致。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role, User } from '../../../shared/types.js';
import { one, rows, run } from '../db.js';

interface Row {
  id: string;
  username: string;
  password_hash: string;
  pin_hash: string | null;
  role: string;
  disabled: boolean;
  created_at: Date;
}

function toUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    role: r.role as Role,
    disabled: !!r.disabled,
    hasPin: !!r.pin_hash,
    createdAt: new Date(r.created_at).getTime(),
  };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function getUser(id: string): Promise<User | undefined> {
  const r = await one<Row>('SELECT * FROM users WHERE id = $1', [id]);
  return r ? toUser(r) : undefined;
}

export async function getUserByUsername(username: string): Promise<(User & { passwordHash: string }) | undefined> {
  const r = await one<Row>('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
  return r ? { ...toUser(r), passwordHash: r.password_hash } : undefined;
}

export async function listUsers(): Promise<User[]> {
  const r = await rows<Row>('SELECT * FROM users ORDER BY created_at ASC');
  return r.map(toUser);
}

export async function countUsers(): Promise<number> {
  return (await one<{ n: number }>('SELECT count(*)::int AS n FROM users'))!.n;
}

export async function createUser(input: {
  username: string;
  password: string;
  role?: Role;
}): Promise<User> {
  const r = await one<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.username.trim(), hashPassword(input.password), input.role ?? 'user'],
  );
  return (await getUser(r!.id))!;
}

export async function setPassword(id: string, password: string) {
  await run('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hashPassword(password)]);
}

export async function setRole(id: string, role: Role) {
  await run('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
}

export async function setDisabled(id: string, disabled: boolean) {
  await run('UPDATE users SET disabled = $2 WHERE id = $1', [id, disabled]);
}

export async function deleteUser(id: string) {
  await run('DELETE FROM users WHERE id = $1', [id]);
}

/** PIN 用账号密码同款 scrypt：随机盐 + 定长比较，明文不落库 */
export function hashPin(pin: string): string {
  return hashPassword(pin);
}

export function verifyPin(pin: string, stored: string): boolean {
  return verifyPassword(pin, stored);
}

export async function getUserSecrets(id: string): Promise<{
  passwordHash: string; pinHash: string | null;
} | undefined> {
  const r = await one<{ password_hash: string; pin_hash: string | null }>(
    'SELECT password_hash, pin_hash FROM users WHERE id = $1', [id],
  );
  return r ? { passwordHash: r.password_hash, pinHash: r.pin_hash } : undefined;
}

export async function setPin(id: string, pin: string) {
  await run('UPDATE users SET pin_hash = $2 WHERE id = $1', [id, hashPin(pin)]);
}

export async function clearPin(id: string) {
  await run('UPDATE users SET pin_hash = NULL WHERE id = $1', [id]);
}
