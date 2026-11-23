/**
 * v1 → v2 数据迁移：entries/dismissals → pursuits/followups。
 *   npm run migrate:v2
 *
 * 幂等：每个用户迁完会在 settings 写 migrated_v2 标记，重跑只补没迁的用户。
 * 必须先部署 v2 表结构（npm run db:init）再跑。
 */
import pg from 'pg';

const { Client } = pg;
const HOST = process.env.PGHOST || '';
const PORT = Number(process.env.PGPORT || 5432);
const DB = process.env.PGDATABASE || 'general_db';
const SCHEMA = process.env.PGSCHEMA || 'desk_alarm';
const USER = process.env.PGUSER || 'desk_alarm';
const PASS = process.env.PGPASSWORD || '';

if (!HOST) {
  console.error('缺少 PGHOST：先 PGHOST=<地址> npm run migrate:v2');
  process.exit(1);
}

const g = (s) => `\x1b[32m${s}\x1b[0m`;

const recurrenceOf = (repeat) => {
  if (!repeat || repeat === 'none') return null;
  return { freq: repeat };
};

async function main() {
  const c = new Client({
    host: HOST, port: PORT, database: DB, user: USER, password: PASS,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  await c.query(`SET search_path TO ${SCHEMA}, public`);

  // 旧表可能已被清理（全新部署），那就没有可迁的
  const old = await c.query(
    `SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'entries'`, [SCHEMA]);
  if (old.rowCount === 0) {
    console.log('没有找到旧的 entries 表，无需迁移');
    await c.end();
    return;
  }

  const users = await c.query('SELECT id FROM users ORDER BY created_at');
  console.log(`发现 ${users.rowCount} 个用户，开始迁移...`);

  let total = 0;
  for (const u of users.rows) {
    const uid = u.id;
    const done = await c.query(
      `SELECT 1 FROM settings WHERE user_id = $1 AND key = 'migrated_v2'`, [uid]);
    if (done.rowCount > 0) continue;

    const entries = await c.query('SELECT * FROM entries WHERE user_id = $1', [uid]);
    const idMap = new Map();

    await c.query('BEGIN');
    try {
      for (const e of entries.rows) {
        const nature = e.repeat && e.repeat !== 'none' ? 'recurring' : 'one_off';
        const importance = e.strength === 'strong' ? 3 : 1;
        const energy = e.bypass_quiet ? 'high' : 'medium';
        const status = e.done_at ? 'done' : 'active';
        const lastActivity = e.updated_at || e.created_at || new Date();

        // 新 id 由数据库生成，用 RETURNING 拿回来供 dismissals 关联
        const ins = await c.query(
          `INSERT INTO pursuits
             (user_id, text, note, kind, url, path, nature, importance, energy,
              due_at, recurrence, status, source, last_activity_at, completed_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING id`,
          [uid, e.text, e.note ?? null, e.kind ?? 'text', e.url ?? null, e.path ?? null,
           nature, importance, energy, e.remind_at ?? null,
           recurrenceOf(e.repeat) ? JSON.stringify(recurrenceOf(e.repeat)) : null,
           status, e.source ?? 'app', lastActivity, e.done_at ?? null,
           e.created_at ?? new Date(), e.updated_at ?? new Date()],
        );
        idMap.set(e.id, ins.rows[0].id);
      }

      const ds = await c.query(
        `SELECT d.* FROM dismissals d WHERE d.user_id = $1`, [uid]);
      for (const d of ds.rows) {
        const pid = idMap.get(d.entry_id);
        if (!pid) continue;
        await c.query(
          `INSERT INTO followups (user_id, pursuit_id, at, level, action, note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uid, pid, d.at ?? new Date(), 2, 'ignored', d.reason ?? null]);
      }

      await c.query(
        `INSERT INTO settings (user_id, key, value) VALUES ($1,'migrated_v2','1')
         ON CONFLICT (user_id, key) DO NOTHING`, [uid]);
      await c.query('COMMIT');
      total += entries.rowCount;
      console.log(`  ${g('✓')} 用户 ${uid}: ${entries.rowCount} 条推进项, ${ds.rowCount} 条忽略记录`);
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  }

  await c.end();
  console.log(`\n${g('迁移完成')} 共 ${total} 条推进项\n`);
}

void main().catch((err) => {
  console.error('迁移失败:', err);
  process.exit(1);
});
