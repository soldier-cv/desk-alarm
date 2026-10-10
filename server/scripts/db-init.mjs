/**
 * 初始化数据库：确保 schema 存在，然后建表。
 *   npm run db:init
 *
 * 幂等，可以反复跑。
 *
 * 共用的库（如 general_db）里当前用户通常没有 CREATE ON DATABASE，
 * 建不了 schema。那种情况需要 owner 先执行一次：
 *   CREATE SCHEMA desk_alarm AUTHORIZATION desk_alarm;
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { Client } = pg;

const HOST = process.env.PGHOST || '100.64.0.88';
const PORT = Number(process.env.PGPORT || 5432);
const DB = process.env.PGDATABASE || 'general_db';
const SCHEMA = process.env.PGSCHEMA || 'desk_alarm';
const USER = process.env.PGUSER || 'desk_alarm';
const PASS = process.env.PGPASSWORD || '';

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;

async function main() {
  console.log(`\n\x1b[1mDeskAlarm 数据库初始化\x1b[0m`);
  console.log(`  ${HOST}:${PORT}/${DB}  schema=${SCHEMA}  用户 ${USER}\n`);

  // 连到目标库。schema 可能还不存在，所以先不设 search_path
  const c = new Client({
    host: HOST, port: PORT, database: DB, user: USER, password: PASS,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await c.connect();
  } catch (err) {
    const code = err.code;
    const why = {
      '28P01': '口令不对',
      '3D000': `数据库 ${DB} 不存在`,
      ECONNREFUSED: '连接被拒绝',
      ETIMEDOUT: '网络不通',
      ENOTFOUND: '主机名解析不了',
    };
    console.error(`\n${r('连不上数据库')}  ${why[code] ?? err.message} (${code})\n`);
    process.exit(1);
  }

  // [1] schema
  const exists = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [SCHEMA]);
  if ((exists.rowCount ?? 0) > 0) {
    console.log(`  schema ${SCHEMA} 已存在`);
  } else {
    try {
      await c.query(`CREATE SCHEMA ${SCHEMA}`);
      console.log(`  ${g(`已创建 schema ${SCHEMA}`)}`);
    } catch {
      console.error(`\n  ${r('schema 不存在，且当前用户没有建库权限')}`);
      console.error(`  让 ${DB} 的 owner 执行：`);
      console.error(`\n      CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${USER};\n`);
      await c.end();
      process.exit(1);
    }
  }

  // [2] 表。search_path 指到自己的 schema，public 只作为兜底
  await c.query(`SET search_path TO ${SCHEMA}, public`);

  const sql = readFileSync(join(here, '..', 'src', 'schema.pg.sql'), 'utf8');
  await c.query(sql);
  console.log(`  ${g('表结构已应用')}`);

  const t = await c.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [SCHEMA]);
  console.log(`  ${SCHEMA} 下的表: ${t.rows.map((x) => x.tablename).join(', ')}`);

  const idx = await c.query(
    `SELECT count(*)::int n FROM pg_indexes WHERE schemaname = $1`, [SCHEMA]);
  console.log(`  索引 ${idx.rows[0].n} 个`);

  // 确认 public 没被污染。共用库里这一条值得每次都看
  const pub = await c.query(`
    SELECT count(*)::int n FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN ('entries','devices','deliveries','dismissals',
                         'sessions','settings','entry_devices','idempotency')`);
  if (pub.rows[0].n > 0) {
    console.log(`\n  ${r('public 里发现了 DeskAlarm 的表，可能是早先建错了地方')}`);
    console.log('  确认没别的项目在用之后可以清理：');
    console.log('\n    DROP TABLE public.entries, public.devices, public.deliveries,');
    console.log('                 public.dismissals, public.sessions,');
    console.log('                 public.settings, public.entry_devices, public.idempotency CASCADE;');
  } else {
    console.log('  public 未被污染');
  }

  await c.end();
  console.log(`\n${g('完成')}\n`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
