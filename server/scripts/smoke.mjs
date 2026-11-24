/**
 * v2 推进引擎冒烟测试。起临时库跑完整链路，验完删库。
 * 覆盖：鉴权 / 推进项 CRUD / 拆解 / 跟进 / 聚焦 / 重复 / nudge 投递 /
 *       WS / MCP 两步防呆 / Agent 令牌 / 乐观锁 / 容错
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import pg from 'pg';

const PORT = Number(process.env.SMOKE_PORT || 8899);
const PGPORT = Number(process.env.PG_TEST_PORT || 15432);
const DB = 'desk_alarm_smoke';
const SCHEMA = 'desk_alarm';
const PG_PASS = process.env.SMOKE_PG_PASSWORD || 'desk_alarm';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const MCP = `http://127.0.0.1:${PORT}/api/mcp`;
const AGENT = `http://127.0.0.1:${PORT}/api/agent`;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* 还没好 */ }
    await sleep(80);
  }
  ok(`${label}（${ms}ms 内没成立）`, false);
  return false;
}
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function mcp(name, args, token) {
  const res = await fetch(`${MCP}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name, arguments: args }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function agent(path, token, method = 'GET', body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(AGENT + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/stream?token=${token}`);
  const inbox = [];
  ws.on('message', (b) => inbox.push(JSON.parse(String(b))));
  const ready = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ws, inbox, ready,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: async (t, ms = 8000, pid = null) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = inbox.find((m) => m.t === t &&
          (pid === null || m.pursuit?.id === pid || m.pursuitId === pid || m.entryId === pid));
        if (hit) return hit;
        await sleep(60);
      }
      return null;
    },
    waitForMatch: async (t, pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = inbox.find((m) => m.t === t && pred(m));
        if (hit) return hit;
        await sleep(60);
      }
      return null;
    },
  };
}

const admin = new pg.Client({
  host: '127.0.0.1', port: PGPORT, database: 'postgres',
  user: 'desk_alarm', password: PG_PASS, options: '-c search_path=public',
});
let adminReady = null;
function connectAdmin() { adminReady ??= admin.connect(); return adminReady; }
async function freshDb() {
  await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
}
async function db() {
  const c = new pg.Client({
    host: '127.0.0.1', port: PGPORT, database: DB,
    user: 'desk_alarm', password: PG_PASS,
    options: `-c search_path=${SCHEMA},public`,
  });
  await c.connect();
  return c;
}

let child = null;
const WATCHDOG_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180_000);
const watchdog = setTimeout(() => {
  fail++; failures.push('看门狗触发');
  console.error(`\n\x1b[31m看门狗\x1b[0m ${WATCHDOG_MS}ms 没跑完`);
  try { child?.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();
function startServer() {
  child = spawn(process.execPath, ['dist/server/src/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PGHOST: '127.0.0.1', PGPORT: String(PGPORT), PGDATABASE: DB, PGSCHEMA: SCHEMA,
      PGUSER: 'desk_alarm', PGPASSWORD: PG_PASS,
      TICK_MS: '200', ROTATE_MS: '200',
      MISSED_AFTER_MS: '1500',
      DELIVERY_RETRY_MS: '3000', DELIVERY_MAX_ATTEMPTS: '2',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}
async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return true; }
    catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

try {
  console.log('\n\x1b[1mDeskAlarm v2 推进引擎冒烟测试\x1b[0m\n');
  try { await connectAdmin(); }
  catch (e) {
    console.error(`\n\x1b[31m连不上本地开发库 127.0.0.1:15432\x1b[0m (${e.code ?? e.message})`);
    console.error('启动它：docker start deskalarm-pg-dev');
    process.exit(2);
  }
  await freshDb();
  startServer();
  ok('服务能起来', await waitReady());

  /* ------------------------------------------------------------ CORS */
  console.log('\nCORS');
  const APP = 'http://tauri.localhost';
  const raw = (p, h = {}, m = 'GET') => fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: h });
  ok('带 ACAO', (await raw('/healthz', { origin: APP })).headers.get('access-control-allow-origin') === APP);
  ok('预检不落 404', (await raw('/api/v1/auth/login', {
    origin: APP, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
  }, 'OPTIONS')).status === 204);
  ok('陌生源无 ACAO', (await raw('/healthz', { origin: 'http://evil.example' })).headers.get('access-control-allow-origin') === null);

  /* ------------------------------------------------------ 管理员初始化 */
  console.log('\n管理员初始化');
  ok('全新库需要初始化', (await api('/setup/status')).json.needed === true);
  const setup = await api('/setup', { method: 'POST', body: {
    username: 'admin', password: 'test-pass-123', confirmPassword: 'test-pass-123', machineId: 'machine-a',
  } });
  ok('初始化成功', setup.status === 201 && !!setup.json.token);
  ok('初始化建了设备', !!setup.json.device?.id);
  ok('初始化后 closed', (await api('/setup/status')).json.needed === false);
  ok('重复初始化被拒', (await api('/setup', { method: 'POST', body: {
    username: 'x', password: 'test-pass-123', confirmPassword: 'test-pass-123',
  } })).status === 409);
  const adminToken = setup.json.token;

  /* ---------------------------------------------------------- 鉴权 */
  console.log('\n鉴权');
  ok('错误密码 401', (await api('/auth/login', { method: 'POST', body: {
    username: 'admin', password: 'wrong', deviceName: 'x', platform: 'windows',
  } })).status === 401);
  ok('无 token 401', (await api('/pursuits')).status === 401);
  const la = await api('/auth/login', { method: 'POST', body: {
    username: 'admin', password: 'test-pass-123', deviceName: '笔记本', platform: 'windows', machineId: 'machine-a',
  } });
  const lb = await api('/auth/login', { method: 'POST', body: {
    username: 'admin', password: 'test-pass-123', deviceName: '台式机', platform: 'windows', machineId: 'machine-b',
  } });
  const lp = await api('/auth/login', { method: 'POST', body: {
    username: 'admin', password: 'test-pass-123', deviceName: '手机', platform: 'android', machineId: 'machine-phone',
  } });
  const ta = la.json.token, tb = lb.json.token, tp = lp.json.token;
  const da = la.json.device.id, dbId = lb.json.device.id, dp = lp.json.device.id;
  ok('三台设备 ID 不同', new Set([da, dbId, dp]).size === 3);

  /* -------------------------------------------------------- 推进项 CRUD */
  console.log('\n推进项');
  const link = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '看这篇文章', kind: 'link', url: 'https://example.com/a?x=1', dueAt: Date.now() + 600_000,
  } });
  ok('建推进项成功', link.status === 201 && !!link.json.pursuit?.id);
  ok('kind 由客户端传入并保存', link.json.pursuit?.kind === 'link');
  ok('默认 importance=1', link.json.pursuit?.importance === 1);
  ok('默认 nature=one_off', link.json.pursuit?.nature === 'one_off');
  ok('带 version 供乐观锁', typeof link.json.pursuit?.version === 'number');
  ok('带 progress/staleness/weight 派生量',
    ['progress', 'stalenessMs', 'weight'].every((k) => typeof link.json.pursuit?.[k] === 'number'));
  const pth = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '读认知负荷', kind: 'path', path: 'D:\\资料\\认知负荷.pdf',
  } });
  ok('path 由客户端传入并保存', pth.json.pursuit?.kind === 'path');
  ok('无时间默认 active（不是收集箱语义）', pth.json.pursuit?.status === 'active');

  const project = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '写季度报告', nature: 'project', importance: 3, steps: ['列提纲', '写初稿', '校对'],
  } });
  const projId = project.json.pursuit.id;
  ok('建项目带 3 个步骤', project.json.pursuit.steps?.length === 3);
  ok('步骤默认 todo', project.json.pursuit.steps?.every((s) => s.state === 'todo'));
  ok('进度初始为 0', project.json.pursuit.progress === 0);

  /* ---------------------------------------------------------- 步骤 */
  console.log('\n步骤与拆解');
  const st = project.json.pursuit.steps[0];
  const stepDone = await api(`/steps/${st.id}`, { method: 'PATCH', token: ta, body: { state: 'done' } });
  ok('勾选步骤完成', stepDone.status === 200);
  ok('进度随之变化', stepDone.json.pursuit?.progress > 0 && stepDone.json.pursuit.progress < 1,
    String(stepDone.json.pursuit?.progress));
  const added = await api(`/pursuits/${projId}/steps`, { method: 'POST', token: ta, body: { text: '发给老板' } });
  ok('新增步骤成功', added.json.pursuit?.steps?.length === 4);

  /* ---------------------------------------------------------- 跟进 */
  console.log('\n跟进');
  const beforeVer = added.json.pursuit.version;
  const beforeActivity = added.json.pursuit.lastActivityAt;
  const later = await api(`/pursuits/${projId}/followup`, { method: 'POST', token: ta, body: {
    action: 'later', to: Date.now() + 2 * 60_000, version: beforeVer, note: '明天再说',
  } });
  ok('later 跟进成功', later.status === 200, `status=${later.status} ${JSON.stringify(later.json)}`);
  ok('later 改了 dueAt', later.json.pursuit?.dueAt > Date.now() + 60_000);
  ok('later 重置了停滞（lastActivityAt 刷新）', later.json.pursuit?.lastActivityAt >= beforeActivity);
  ok('version +1', later.json.pursuit?.version === beforeVer + 1);

  const stale = await api(`/pursuits/${projId}/followup`, { method: 'POST', token: ta, body: {
    action: 'done', version: beforeVer,
  } });
  ok('旧版本跟进被拒 409', stale.status === 409, `status=${stale.status}`);

  const smaller = await api(`/pursuits/${projId}/followup`, { method: 'POST', token: ta, body: {
    action: 'smaller', version: later.json.pursuit.version, steps: ['先写第一段'],
  } });
  ok('smaller 补了步骤', smaller.json.pursuit?.steps?.length === 5);

  const done = await api(`/pursuits/${projId}/followup`, { method: 'POST', token: ta, body: {
    action: 'done', version: smaller.json.pursuit.version,
  } });
  ok('done 关闭事项', done.json.pursuit?.status === 'done');
  ok('done 写 completedAt', typeof done.json.pursuit?.completedAt === 'number');

  const afterDone = await api(`/pursuits/${projId}/followup`, { method: 'POST', token: ta, body: {
    action: 'done', version: done.json.pursuit.version,
  } });
  ok('已完成事项拒绝再次跟进（400，不误报成设备冲突）', afterDone.status === 400,
    `status=${afterDone.status}`);

  const followups = await db();
  const fuRows = await followups.query('SELECT action FROM followups WHERE pursuit_id = $1 ORDER BY at', [projId]);
  ok('跟进历史落库（later/smaller/done 三条，stale 被拒不落库）', fuRows.rowCount === 3, `${fuRows.rowCount} 条`);
  ok('历史动作齐全', ['later', 'smaller', 'done'].every((a) => fuRows.rows.some((r) => r.action === a)));
  await followups.end();

  /* ---------------------------------------------------------- 聚焦 */
  console.log('\n今日聚焦');
  const focus = await api('/focus', { token: ta });
  ok('focus 接口 200', focus.status === 200);
  ok('focus 带 items', Array.isArray(focus.json.items));
  ok('focus 带剩余额度', typeof focus.json.budgetLeft === 'number');
  const high = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '最高优先级的事', importance: 3, dueAt: Date.now() - 60_000,
  } });
  const focus2 = await api('/focus', { token: ta });
  ok('紧急事项排进聚焦前列', focus2.json.items?.[0]?.pursuit?.id === high.json.pursuit.id,
    JSON.stringify(focus2.json.items?.slice(0, 2).map((i) => [i.pursuit.id, i.pursuit.weight])));
  ok('聚焦项带理由和下一步建议',
    typeof focus2.json.items?.[0]?.reason === 'string' &&
    typeof focus2.json.items?.[0]?.suggestedNextStep === 'string');

  /* ------------------------------------------------------------ WS */
  console.log('\n实时通道');
  const ca = connect(ta), cb = connect(tb);
  await Promise.all([ca.ready, cb.ready]);
  const welcome = await ca.waitFor('welcome');
  ok('收到 welcome', !!welcome);
  ok('welcome 带权威时间', typeof welcome?.serverTs === 'number');
  ok('welcome 带新设置', typeof welcome?.settings?.dailyStrongBudget === 'number');
  ok('welcome 带 missed 数组', Array.isArray(welcome?.missed));
  ca.send({ t: 'ping', at: Date.now() });
  ok('ping 有 pong', !!(await ca.waitFor('pong')));

  /* ------------------------------------------------------ Nudge 投递 */
  console.log('\nNudge 投递与打扰等级');
  const c1 = await db();
  const urgent = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '紧急推进', importance: 3, dueAt: Date.now() + 500,
  } });
  // 人为把 last_activity 调老，触发高等级
  await c1.query('UPDATE pursuits SET last_activity_at = now() - interval \'4 days\' WHERE id = $1', [urgent.json.pursuit.id]);
  const nudge = await ca.waitFor('pursuit.nudge', 8000, urgent.json.pursuit.id);
  ok('收到 pursuit.nudge', !!nudge);
  ok('nudge 带等级', typeof nudge?.level === 'number');
  ok('nudge 带理由', typeof nudge?.reason === 'string');
  await waitUntil(async () => {
    const r = await c1.query(`SELECT count(*)::int n FROM nudges WHERE pursuit_id = $1`, [urgent.json.pursuit.id]);
    return r.rows[0].n >= 1;
  }, 'nudge 落 outbox');
  const nRows = await c1.query('SELECT level, channel, state FROM nudges WHERE pursuit_id = $1', [urgent.json.pursuit.id]);
  ok('outbox 有记录', nRows.rowCount >= 1);
  ok('高等级走 takeover 通道', nRows.rows.some((r) => r.level >= 4 ? r.channel === 'takeover' : true));
  await c1.end();

  /* ------------------------------------------------------ 到点通知 */
  console.log('\n到点通知');
  // 关掉静音时段，否则夜间跑冒烟会跳过到点通知，测试就不稳了
  await api('/settings', { method: 'PATCH', token: ta, body: {
    quietStartMin: 0, quietEndMin: 0,
  } });
  const cd = await db();
  const due = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '到点了要做的事', dueAt: Date.now() - 1000,
  } });
  const dueId = due.json.pursuit.id;
  // 同一条会先收到 L1 聚焦 nudge；另外多条同时到点时只会推权重最高那条，
  // 所以这里等的是「任意一条到点 L2」，具体条目在下面用 outbox 精确校验。
  const dueNudge = await ca.waitForMatch('pursuit.nudge', (m) =>
    m.level === 2 && String(m.reason).includes('到点了'));
  ok('到点收到 L2 通知', !!dueNudge);
  ok('到点是 notification 通道', dueNudge?.channel === 'notification');
  ok('到点文案不说内部等级', typeof dueNudge?.reason === 'string' && dueNudge.reason.includes('到点了'));
  await waitUntil(async () => {
    const r = await cd.query(
      `SELECT count(*)::int n FROM nudges WHERE pursuit_id = $1 AND fire_key LIKE 'due-%'`, [dueId],
    );
    return r.rows[0].n >= 1;
  }, '到点 nudge 落 outbox');
  await sleep(700);
  const dueRows = await cd.query(
    `SELECT fire_key FROM nudges WHERE pursuit_id = $1 AND fire_key LIKE 'due-%'`, [dueId],
  );
  ok('到点只触发一次', dueRows.rowCount === 1, `${dueRows.rowCount} 条`);
  await cd.end();

  /* ---------------------------------------------------------- 重复 */
  console.log('\n重复规则');
  const rep = await api('/pursuits', { method: 'POST', token: ta, body: {
    text: '每天吃药', nature: 'recurring', recurrence: { freq: 'daily' }, dueAt: Date.now() - 1000,
  } });
  const repId = rep.json.pursuit.id;
  await waitUntil(async () => {
    const r = await api(`/pursuits/${repId}`, { token: ta });
    return r.json.pursuit?.dueAt > Date.now();
  }, '重复项排下一次');
  const repAfter = (await api(`/pursuits/${repId}`, { token: ta })).json.pursuit;
  ok('daily 下次约 1 天后', Math.abs(repAfter.dueAt - Date.now() - 86400_000) < 10_000,
    `diff=${repAfter.dueAt - Date.now()}`);

  /* -------------------------------------------------------- 乐观锁 */
  console.log('\n并发修改');
  const race = await api('/pursuits', { method: 'POST', token: ta, body: { text: '并发改它' } });
  const rv = race.json.pursuit.version;
  const r1 = await api(`/pursuits/${race.json.pursuit.id}`, { method: 'PATCH', token: ta, body: {
    text: '甲改的', version: rv,
  } });
  const r2 = await api(`/pursuits/${race.json.pursuit.id}`, { method: 'PATCH', token: tb, body: {
    text: '乙改的', version: rv,
  } });
  ok('先到的成功', r1.status === 200);
  ok('旧版本被拒 409', r2.status === 409, `status=${r2.status}`);
  ok('409 带当前值', r2.json.current?.text === '甲改的');

  /* ---------------------------------------------------------- 设置 */
  console.log('\n设置');
  const gs = await api('/settings', { token: ta });
  ok('设置可取', gs.status === 200 && typeof gs.json.settings?.dailyStrongBudget === 'number');
  const ps = await api('/settings', { method: 'PATCH', token: ta, body: { dailyStrongBudget: 5 } });
  ok('设置可改', ps.json.settings?.dailyStrongBudget === 5);
  const wb = await ca.waitFor('settings.changed');
  ok('设置变更广播', !!wb);

  /* ------------------------------------------------------------ MCP */
  console.log('\nMCP / Agent 令牌');
  const issued = await api('/agent-tokens', { method: 'POST', token: ta, body: {
    name: '冒烟 Agent', machineId: 'machine-a', scope: 'write',
  } });
  const AT = issued.json.plain;
  ok('签发 Agent 令牌', issued.status === 201 && !!AT);
  ok('令牌只显示一次明文', !issued.json.token?.hash);
  const readIssued = await api('/agent-tokens', { method: 'POST', token: ta, body: {
    name: '只读 Agent', scope: 'read',
  } });
  const RT = readIssued.json.plain;
  ok('无 token 调 MCP 被拒', (await mcp('list_pursuits', {}, null)).status === 401);
  ok('登录 token 调 MCP 被拒', (await mcp('list_pursuits', {}, ta)).status === 403);
  ok('只读令牌可读', (await mcp('list_pursuits', {}, RT)).status === 200);
  ok('只读令牌不能写', (await mcp('create_pursuit', { text: '不该建成' }, RT)).status === 403);
  ok('Agent 令牌进不了主 API', (await api('/pursuits', { token: AT })).status === 403);
  ok('Agent API 可访问', (await agent('/whoami', AT)).status === 200);
  ok('登录 token 进不了 Agent API', (await agent('/whoami', ta)).status === 403);

  const tools = (await fetch(`${MCP}/tools`, { headers: { authorization: `Bearer ${AT}` } })
    .then((r) => r.json())).tools;
  ok('工具清单可取', tools.length >= 10, `${tools.length} 个`);
  ok('有 today_digest / plan_changes / apply_changes',
    ['today_digest', 'plan_changes', 'apply_changes'].every((n) => tools.some((t) => t.name === n)));
  ok('有 decompose / followup / reprioritize',
    ['decompose', 'followup', 'reprioritize'].every((n) => tools.some((t) => t.name === n)));

  const digest = await mcp('today_digest', {}, AT);
  ok('today_digest 可调', digest.status === 200);
  ok('digest 汇总非空', digest.json.result?.聚焦数 !== undefined);
  ok('digest 给 agent 提示', /建议|确认/.test(digest.json.result?.提示 ?? ''));

  const badStrong = await mcp('create_pursuit', { text: 'agent 擅自建高优先级', importance: 3 }, AT);
  ok('高优先级无 reason 被拦', badStrong.status === 400, `status=${badStrong.status}`);
  const countBefore = (await mcp('list_pursuits', {}, AT)).json.result?.总数;
  const okLow = await mcp('create_pursuit', { text: 'agent 建普通推进项' }, AT);
  ok('普通推进项阶段成功', okLow.status === 200 && !!okLow.json.result?.planId);
  const countStaged = (await mcp('list_pursuits', {}, AT)).json.result?.总数;
  ok('阶段不落库', countStaged === countBefore, `${countBefore} → ${countStaged}`);

  const apply1 = await mcp('apply_changes', { planId: okLow.json.result.planId }, AT);
  ok('apply_changes 成功', apply1.status === 200);
  const countAfter = (await mcp('list_pursuits', {}, AT)).json.result?.总数;
  ok('apply 之后才落库（+1）', countAfter === countBefore + 1, `${countStaged} → ${countAfter}`);
  const apply2 = await mcp('apply_changes', { planId: okLow.json.result.planId }, AT);
  ok('plan 不能用第二次', apply2.status === 400, `status=${apply2.status}`);

  /* -------------------------------------------------------- 容错 */
  console.log('\n容错');
  const blank = await api('/pursuits', { method: 'POST', token: ta, body: { text: '   ' } });
  ok('全空格 text 被拒', blank.status === 400);
  const badEnum = await api('/pursuits', { method: 'POST', token: ta, body: { text: 'x', importance: 9 } });
  ok('非法 importance 被拒', badEnum.status === 400);
  const badRec = await api('/pursuits', { method: 'POST', token: ta, body: { text: 'x', recurrence: { freq: 'hourly' } } });
  ok('非法重复规则被拒', badRec.status === 400);
  const junk = await fetch(`${BASE}/pursuits`, {
    method: 'POST', headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/json' }, body: '{ 坏 json',
  });
  ok('坏 JSON 报 400', junk.status === 400);
  await junk.body?.cancel();
  const huge = await fetch(`${BASE}/pursuits`, {
    method: 'POST', headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  });
  ok('超大 body 报 413', huge.status === 413);
  await huge.body?.cancel();

  ca.ws.close(); cb.ws.close();
  console.log(`\n${g('\n结果')} ${pass} 通过, ${fail} 失败`);
  if (failures.length) console.log('失败项:\n  - ' + failures.join('\n  - '));
  await admin.end();
  clearTimeout(watchdog);
  child?.kill('SIGTERM');
  await sleep(300);
  process.exit(fail ? 1 : 0);
} catch (err) {
  console.error('\n测试异常:', err);
  try { await admin.end(); } catch { /* ignore */ }
  child?.kill('SIGKILL');
  clearTimeout(watchdog);
  process.exit(1);
}

function g(s) { return `\x1b[1m${s}\x1b[0m`; }
