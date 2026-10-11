import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * bigint/numeric 默认会被 pg 转成字符串，避免精度丢失，
 * 但我们只有自增 id 用 bigint，转成 number 更好用。
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  database: env.PGDATABASE,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  /**
   * timezone 固定 UTC，免得换台机器就偏掉。
   * search_path 把表关在自己的 schema 里，共用库不往 public 塞
   */
  options: `-c timezone=UTC -c search_path=${env.PGSCHEMA},public`,
});

pool.on('error', (err) => {
  // 后端被重启或网络抖动时，pg 会抛这个。不处理会让进程崩掉
  console.error('[db] 空闲连接异常:', err.message);
});

/** 建表。幂等，可以每次启动都跑 */
export async function migrate(): Promise<void> {
  const sql = readFileSync(join(here, 'schema.pg.sql'), 'utf8');
  await pool.query(sql);
}

/**
 * schema 不存在时给出可操作的提示。
 * 共用库里用户通常没有 CREATE ON DATABASE，建不了 schema 只能由 owner 先建好
 */
export async function ensureSchema(): Promise<{ ok: boolean; hint: string }> {
  const has = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
    [env.PGSCHEMA],
  );
  if ((has?.n ?? 0) > 0) return { ok: true, hint: '' };

  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${env.PGSCHEMA}`);
    return { ok: true, hint: '' };
  } catch (err) {
    const e = err as { code?: string };
    return {
      ok: false,
      hint: e.code === '42501'
        ? `schema ${env.PGSCHEMA} 不存在，而且 ${env.PGUSER} 没有建库权限。` +
          `让 ${env.PGDATABASE} 的 owner 执行: ` +
          `CREATE SCHEMA ${env.PGSCHEMA} AUTHORIZATION ${env.PGUSER};`
        : `建 schema 失败: ${(err as Error).message}`,
    };
  }
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * 连不上时区分是哪一类问题。「连不上数据库」排查时毫无用处，
 * 得知道是网络不通、口令不对、还是库没建
 */
export async function diagnose(): Promise<{
  ok: boolean; reason: string; hint: string; target?: Record<string, unknown>;
}> {
  const target = {
    host: env.PGHOST, port: env.PGPORT, database: env.PGDATABASE, user: env.PGUSER,
  };
  try {
    await pool.query('select 1');
    return { ok: true, reason: '', hint: '', target };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    switch (e.code) {
      case '3D000':
        return {
          ok: false, target,
          reason: `数据库 ${env.PGDATABASE} 不存在（${e.code}）`,
          hint: `让管理员在 ${env.PGHOST} 上执行: CREATE DATABASE ${env.PGDATABASE} OWNER ${env.PGUSER};`,
        };
      case '28P01':
        return { ok: false, target, reason: `口令不对（${e.code}）`, hint: '检查 .env 里的 PGPASSWORD' };
      case '28000':
        return {
          ok: false, target, reason: `认证方式不支持（${e.code}）`,
          hint: '可能走了 peer 或 scram。容器里要用 md5 或 password 认证',
        };
      case 'ECONNREFUSED':
        return { ok: false, target, reason: '连接被拒绝', hint: '确认 Postgres 起来了且端口对' };
      case 'ETIMEDOUT':
      case 'ENOTFOUND':
        return {
          ok: false, target, reason: '网络不通',
          hint: '容器里 127.0.0.1 指容器自己。访问宿主机要用 host.docker.internal 或内网 IP',
        };
      default:
        return { ok: false, target, reason: e.message ?? '未知原因', hint: '' };
    }
  }
}

/* ---------------------------------------------------------------- 查询 */

/** 取多行 */
export async function rows<T = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  const r = await pool.query(sql, params as never[]);
  return r.rows as T[];
}

/** 取一行，没有返回 undefined */
export async function one<T = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
): Promise<T | undefined> {
  const r = await pool.query(sql, params as never[]);
  return r.rows[0] as T | undefined;
}

/** 只执行不返回 */
export async function run(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params as never[]);
  return r.rowCount ?? 0;
}

/** 取第一行第一列 */
export async function scalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await pool.query(sql, params as never[]);
  return r.rows[0] ? Object.values(r.rows[0])[0] as T : undefined;
}

/**
 * 事务。回调里用 q 而不是顶层函数：pg 事务必须固定在一条连接上，
 * 混用会导致事务外的连接跑进同一个事务，产生难查的锁问题
 */
export async function tx<T>(fn: (q: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q: Tx = {
      rows: async (sql, params = []) => (await client.query(sql, params as never[])).rows,
      one: async (sql, params = []) => (await client.query(sql, params as never[])).rows[0],
      run: async (sql, params = []) => (await client.query(sql, params as never[])).rowCount ?? 0,
      scalar: async <T = unknown,>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params as never[]);
        return (r.rows[0] ? Object.values(r.rows[0])[0] : undefined) as T | undefined;
      },
    };
    const out = await fn(q);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* 连接已经断了就算了 */ }
    throw err;
  } finally {
    client.release();
  }
}

export interface Tx {
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<number>;
  scalar<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

export const now = () => Date.now();
export const uid = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '');

/** timestamptz -> epoch 毫秒 */
export const toMs = (v: Date | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** epoch 毫秒 -> timestamptz 参数 */
export const toDt = (v: number | string | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
};
