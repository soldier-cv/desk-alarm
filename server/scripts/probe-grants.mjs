/** 查 desk_alarm 在目标库里到底有哪些权限。
 *  用法：PGHOST=... PGPASSWORD=... node scripts/probe-grants.mjs */
import pg from 'pg';

if (!process.env.PGHOST) {
  console.error('缺少 PGHOST：PGHOST=<数据库地址> PGPASSWORD=<口令> node scripts/probe-grants.mjs');
  process.exit(1);
}

const c = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'general_db',
  user: process.env.PGUSER || 'desk_alarm',
  password: process.env.PGPASSWORD || '',
});
await c.connect();

console.log('=== schema 权限 ===');
const s = await c.query(`
  select n.nspname as schema,
         has_schema_privilege(current_user, n.nspname, 'USAGE')  as usage,
         has_schema_privilege(current_user, n.nspname, 'CREATE') as create
    from pg_namespace n
   where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
   order by n.nspname`);
for (const r of s.rows) {
  const mark = r.create ? '\x1b[32m可建表\x1b[0m' : r.usage ? '\x1b[33m只可读\x1b[0m' : '\x1b[90m无权限\x1b[0m';
  console.log(`  ${r.schema.padEnd(20)} usage=${r.usage ? 'Y' : 'N'}  create=${r.create ? 'Y' : 'N'}  ${mark}`);
}

console.log('\n=== 有 CREATE 权限的 schema ===');
const writable = s.rows.filter((r) => r.create).map((r) => r.schema);
if (writable.length === 0) {
  console.log('  \x1b[31m一个都没有\x1b[0m');
} else {
  for (const sc of writable) {
    const t = await c.query(
      `select count(*)::int n from pg_tables where schemaname = $1`, [sc]);
    console.log(`  ${sc}: ${t.rows[0].n} 张表`);
  }
}

console.log('\n=== 直接点名桌面的 GRANT ===');
const g = await c.query(`
  select nspname as schema, nspacl::text as acl
    from pg_namespace
   where nspname not like 'pg\\_%' and nspacl is not null
   order by nspname`);
if (g.rowCount === 0) console.log('  没有任何 schema 有 ACL 记录');
for (const r of g.rows) {
  console.log(`  ${r.schema}:`);
  for (const line of String(r.acl).split(',').filter((x) => x.includes('desk_alarm'))) {
    console.log(`    ${line.trim()}`);
  }
}

console.log('\n=== 我的角色 ===');
const r2 = await c.query(`
  select r.rolname, r.rolsuper, r.rolcreatedb, m.member::regrole[] as roles
    from pg_roles r left join pg_auth_members m on r.oid = m.roleid
   where r.rolname = current_user`);
console.log(' ', JSON.stringify(r2.rows[0]));

console.log('\n=== owner 能不能给我开权限 ===');
const owner = await c.query(`
  select pg_get_userbyid(datdba) as owner from pg_database where datname = current_database()`);
console.log(`  ${owner.rows[0].owner} 是这个库的 owner，需要它来授权`);

await c.end();
