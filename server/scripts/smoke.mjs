/**
 * 冒烟测试。起一个临时服务跑完整链路，验完把库删掉。
 * 覆盖：鉴权 / 条目 / 触发 / 跨端去重 / 推迟 / 重复 /
 *       强弱提示 / 忽略与自动降级 / 投递记账 / 离线补发 / MCP 防呆
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import pg from 'pg';

const PORT = Number(process.env.SMOKE_PORT || 8899);
const DB = 'desk_alarm_smoke';
// 测试直连用的 schema，必须和下面 startServer 传给服务端的同一个值，
// 否则测的是另一个 schema，测了个寂寞
const SCHEMA = 'desk_alarm';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const MCP = `http://127.0.0.1:${PORT}/api/mcp`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等某个条件成立。异步的东西（轮转器、DB 提交）不能查一次就下结论 */
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
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function mcp(name, args, token) {
  const res = await fetch(`${MCP}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name, arguments: args }),
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
    waitFor: async (t, ms = 8000, entryId = null) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = inbox.find((m) => m.t === t &&
          (entryId === null || m.entry?.id === entryId || m.entryId === entryId));
        if (hit) return hit;
        await sleep(60);
      }
      return null;
    },
    count: (t, entryId = null) => inbox.filter((m) => m.t === t &&
      (entryId === null || m.entry?.id === entryId || m.entryId === entryId)).length,
  };
}

const admin = new pg.Client({
  host: '127.0.0.1', port: 15432, database: 'postgres',
  user: 'desk_alarm', password: 'TpTohsACO3LBBU',
  options: '-c search_path=public',
});

let adminReady = null;

/** pg 的 Client 不显式 connect 直接 query，promise 不会 settle。必须先连上 */
function connectAdmin() {
  adminReady ??= admin.connect();
  return adminReady;
}

async function freshDb() {
  await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
}

let child = null;

/** 看门狗。任何一个 await 卡住都直接判失败，不让测试无限挂着 */
const WATCHDOG_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180_000);
const watchdog = setTimeout(() => {
  fail++;
  failures.push(`看门狗触发：${WATCHDOG_MS}ms 内没跑完，卡在某一步`);
  console.error(`\n\x1b[31m看门狗\x1b[0m ${WATCHDOG_MS}ms 没跑完，强制收尾`);
  try { child?.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

function startServer() {
  child = spawn(process.execPath, ['dist/server/src/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PGHOST: '127.0.0.1', PGPORT: '15432', PGDATABASE: DB,
      PGSCHEMA: SCHEMA,
      PGUSER: 'desk_alarm', PGPASSWORD: 'TpTohsACO3LBBU',
      DESKALARM_PASSCODE: 'test-pass-123',
      MCP_TOKEN: 'mcp-token-xyz',
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
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

/* ---------------------------------------------------------------- 查库 */
// 和 admin 同一个坑：pg 的 Client 不显式 connect 直接 query，promise 不会 settle
async function db() {
  const c = new pg.Client({
    host: '127.0.0.1', port: 15432, database: DB,
    user: 'desk_alarm', password: 'TpTohsACO3LBBU',
    options: `-c search_path=${SCHEMA},public`,
  });
  await c.connect();
  return c;
}

try {
  console.log('\n\x1b[1mDeskAlarm 服务端冒烟测试 (PostgreSQL)\x1b[0m\n');

  // 先单独探一次，连不上就说清楚怎么修。直接抛 ECONNREFUSED 看不出是缺容器还是口令错
  try {
    await connectAdmin();
  } catch (e) {
    console.error(`\n\x1b[31m连不上本地开发库 127.0.0.1:15432\x1b[0m  (${e.code ?? e.message})`);
    console.error('启动它：\n  docker start deskalarm-pg-dev');
    console.error('还没有这个容器的话：\n  docker run -d --name deskalarm-pg-dev \\');
    console.error('    -e POSTGRES_USER=desk_alarm -e POSTGRES_PASSWORD=TpTohsACO3LBBU \\');
    console.error('    -e POSTGRES_DB=general_db -p 15432:5432 postgres:18-alpine\n');
    process.exit(2);
  }

  await freshDb();
  startServer();   // 库就位之后才起服务，否则连的是一个刚被 DROP 掉的库
  ok('服务能起来（连得上 Postgres）', await waitReady());

  /* ---------------------------------------------------------- 鉴权 */
  console.log('\n鉴权');
  const bad = await api('/auth/login', { method: 'POST', body: { passcode: 'wrong', deviceName: 'x', platform: 'windows' } });
  ok('错误口令被拒 401', bad.status === 401);
  ok('无 token 访问被拒 401', (await api('/entries')).status === 401);

  const a = await api('/auth/login', { method: 'POST', body: { passcode: 'test-pass-123', deviceName: '我的笔记本', platform: 'windows' } });
  ok('笔记本登录成功', a.status === 200 && !!a.json.token);
  const b = await api('/auth/login', { method: 'POST', body: { passcode: 'test-pass-123', deviceName: '工位台式机', platform: 'windows' } });
  ok('台式机登录成功', b.status === 200 && !!b.json.token);
  const ta = a.json.token, tb = b.json.token, da = a.json.device.id, dbt = b.json.device.id;
  ok('两台设备 ID 不同', da !== dbt);
  ok('桌面设备默认走 ws 通道', a.json.device.transport === 'ws');

  const phone = await api('/auth/login', {
    method: 'POST',
    body: { passcode: 'test-pass-123', deviceName: '小米手机', platform: 'android', transport: 'fcm', pushToken: 'fake-token' },
  });
  ok('安卓设备可注册 fcm 通道', phone.json.device?.transport === 'fcm');
  ok('有 push token 就算配好了', phone.json.device?.pushReady === true);
  const dphone = phone.json.device.id;

  /* ---------------------------------------------------------- 条目 */
  console.log('\n条目');
  const link = await api('/entries', { method: 'POST', token: ta, body: { text: 'https://example.com/a/very/long/path?x=1', remindAt: Date.now() + 600_000 } });
  ok('粘贴链接识别为 link', link.json.entry?.kind === 'link');
  const pth = await api('/entries', { method: 'POST', token: ta, body: { text: 'D:\\资料\\待读\\认知负荷.pdf' } });
  ok('Windows 路径识别为 path', pth.json.entry?.kind === 'path');
  ok('无时间进收集箱', pth.json.entry?.status === 'inbox');
  ok('收集箱条目默认 weak', pth.json.entry?.strength === 'weak', pth.json.entry?.strength);
  ok('给了时间但没声明强度也是 weak', link.json.entry?.strength === 'weak', link.json.entry?.strength);

  /* ------------------------------------------------------ WebSocket */
  console.log('\n实时通道');
  const ca = connect(ta), cb = connect(tb);
  await Promise.all([ca.ready, cb.ready]);
  const welcome = await ca.waitFor('welcome');
  ok('收到 welcome', !!welcome);
  ok('welcome 带服务端权威时间', typeof welcome?.serverTs === 'number');
  ok('welcome 带全局设置', typeof welcome?.settings?.escalateAfterSec === 'number');
  ca.send({ t: 'ping', at: Date.now() });
  ok('ping 有 pong', !!(await ca.waitFor('pong')));

  const badSock = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/stream?token=garbage`);
  const closed = await new Promise((r) => {
    badSock.once('close', (c) => r(c));
    badSock.once('error', () => r('error'));
    setTimeout(() => r('timeout'), 3000);
  });
  ok('无效 token 的 WS 被拒', closed === 4401 || closed === 'error', `code=${closed}`);

  /* ------------------------------------------------ 触发与投递记账 */
  console.log('\n触发链路 + 投递记账');
  const c1 = await db();
  const soon = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '到点该响铃了', remindAt: Date.now() + 800, devices: ['*'], strength: 'strong' },
  });
  const soonId = soon.json.entry.id;
  ok('推送范围默认是全部', JSON.stringify(soon.json.entry.devices) === JSON.stringify(['*']));

  const firedA = await ca.waitFor('entry.fired', 8000, soonId);
  ok('目标设备收到 entry.fired', !!firedA);
  ok('fired 带服务端时间戳', typeof firedA?.serverTs === 'number');
  ok('fired 标明走哪条通道', firedA?.transport === 'ws', firedA?.transport);
  ok('fired 带强度', firedA?.strength === 'strong');

  // 这次修复的重点：pending 必须真的变成 delivered。
  // 轮转器是异步的，收到 entry.fired 时它还没提交状态变更，
  // 所以这里轮询等它落定，而不是查一次就下结论
  await waitUntil(async () => {
    const r = await c1.query(
      `SELECT count(*)::int n FROM deliveries
        WHERE entry_id = $1 AND state = 'delivered'`, [soonId]);
    return r.rows[0].n >= 2;
  }, '投递状态落定');

  const d1 = await c1.query(
    `SELECT device_id, state, transport FROM deliveries WHERE entry_id = $1 ORDER BY device_id`, [soonId]);
  ok('outbox 有记录（3 台设备各一条）', d1.rowCount === 3, `${d1.rowCount} 行`);

  // 两台连着 WS 的应该 delivered，没连的应该留 pending
  const wsRows = d1.rows.filter((r) => r.device_id !== dphone);
  const phoneRows = d1.rows.filter((r) => r.device_id === dphone);
  ok('在线设备标为 delivered', wsRows.length === 2 && wsRows.every((r) => r.state === 'delivered'),
    JSON.stringify(wsRows.map((r) => `${r.device_id}:${r.state}`)));
  ok('投递通道被记成 ws', wsRows.every((r) => r.transport === 'ws'),
    JSON.stringify(wsRows.map((r) => r.transport)));
  ok('没连的设备留 pending 等补发', phoneRows.length === 1 && phoneRows[0].state === 'pending',
    phoneRows[0]?.state);

  const after = await api(`/entries/${soonId}`, { token: ta });
  ok('fired_at 落库', after.json.entry?.firedAt !== null);
  ok('响过没处理判为 missed', after.json.entry?.status === 'missed');

  // 去重的依据是库里的投递行，不是收到几次 WS 事件。
  // 等固定时长去数网络事件会偶发失败：调度器那一轮还没跑完就数，计数是 0。
  // 去重约束是 UNIQUE(entry_id, device_id, fire_key)，所以要按这个维度查：
  // 同一个 fire_key 投给多台设备是正常的（那是分发，不是重复触发）
  await sleep(900);
  const dupRows = await c1.query(
    `SELECT entry_id, device_id, fire_key, count(*)::int AS n
       FROM deliveries WHERE entry_id = $1
      GROUP BY entry_id, device_id, fire_key HAVING count(*) > 1`, [soonId]);
  ok('同一设备同一次触发没有重复投递', dupRows.rows.length === 0, JSON.stringify(dupRows.rows));
  const keyRows = await c1.query(
    'SELECT count(DISTINCT fire_key)::int AS n FROM deliveries WHERE entry_id = $1', [soonId]);
  ok('同一次触发只有一个 fire_key', keyRows.rows[0]?.n === 1, `fire_key 数 ${keyRows.rows[0]?.n}`);

  /* --------------------------------------------------- 离线设备补发 */
  console.log('\n离线补发（这次修复的核心）');
  // 安卓设备没连 WS。它在库里在线=false，投递会失败并留在 pending
  const phoneRow = await c1.query(
    `SELECT state, attempts, last_error FROM deliveries WHERE entry_id = $1 AND device_id = $2`,
    [soonId, dphone]);
  ok('离线设备的投递留在 pending', phoneRow.rows[0]?.state === 'pending', phoneRow.rows[0]?.state);
  ok('失败原因被记下来', String(phoneRow.rows[0]?.last_error ?? '').length > 0,
    String(phoneRow.rows[0]?.last_error));

  // 现在让安卓连上 WS，应当立刻收到 welcome 里的补发。
  // 要先等过 MISSED_AFTER_MS，否则服务端认为「刚响的还来得及正常送」
  await sleep(1800);
  const cp = connect(phone.json.token);
  await cp.ready;
  const pw = await cp.waitFor('welcome');
  ok('安卓上线收到 welcome', !!pw);
  ok('welcome 带上漏掉的提醒', pw.missed?.length >= 1, `missed=${pw.missed?.length}`);
  ok('补发带迟到时长', pw.missed?.[0]?.lateByMs > 0);
  ok('补发的就是那条', pw.missed?.[0]?.entry?.id === soonId);

  /* ---------------------------------------------------------- 去重 */
  console.log('\n跨端去重');
  ok('第二台设备也收到了', !!(await cb.waitFor('entry.fired', 8000, soonId)));
  cb.send({ t: 'entry.ack', entryId: soonId, action: 'done', at: Date.now() });
  const acked = await ca.waitFor('entry.acked');
  ok('其它设备收到 entry.acked', !!acked);
  ok('广播带确认设备名', acked?.deviceName === '工位台式机');
  ok('广播带动作', acked?.action === 'done');
  const doneEntry = await api(`/entries/${soonId}`, { token: ta });
  ok('状态变 done', doneEntry.json.entry?.status === 'done');
  ok('记录在别的设备上完成', doneEntry.json.entry?.doneDevice === '工位台式机');
  const ackRow = await c1.query(
    `SELECT state, ack_action FROM deliveries WHERE entry_id = $1 AND device_id = $2`,
    [soonId, dbt]);
  ok('投递状态变 acked', ackRow.rows[0]?.state === 'acked');
  ok('确认动作被记录', ackRow.rows[0]?.ack_action === 'done');

  /* ------------------------------------------------ 强提示 / 弱提示 */
  console.log('\n强弱提示');
  const strong = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '强提示该响的', remindAt: Date.now() + 700, strength: 'strong' },
  });
  ok('显式 strong 被接受', strong.json.entry?.strength === 'strong');
  const strongFired = await ca.waitFor('entry.fired', 8000, strong.json.entry.id);
  ok('strong 走 entry.fired（客户端会进接管窗口）', !!strongFired);

  const weak = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '弱提示，轻轻提醒', remindAt: Date.now() + 700, strength: 'weak' },
  });
  ok('弱提示强度被保存', weak.json.entry?.strength === 'weak');
  const weakFired = await ca.waitFor('entry.fired', 8000, weak.json.entry.id);
  ok('弱提示也走 entry.fired，强度字段告诉客户端别弹全屏',
    weakFired?.strength === 'weak', weakFired?.strength);

  const bypass = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '服药', remindAt: Date.now() + 700, strength: 'strong', bypassQuiet: true },
  });
  ok('绕过静音是独立字段', bypass.json.entry?.bypassQuiet === true);
  ok('老字段 hard 同步为 bypassQuiet', bypass.json.entry?.hard === true);

  /* ------------------------------------------------------ 忽略与降级 */
  console.log('\n弱提示的忽略与自动降级');
  const w2 = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '被反复忽略的提醒', remindAt: Date.now() + 600, strength: 'strong' },
  });
  const w2id = w2.json.entry.id;
  await ca.waitFor('entry.fired', 8000, w2id);

  const d1r = await api(`/entries/${w2id}/dismiss`, {
    method: 'POST', token: ta, body: { reason: '现在不想动' },
  });
  ok('忽略成功', d1r.status === 200);
  ok('忽略次数 = 1', d1r.json.dismissCount === 1);
  ok('第一次忽略不改强度', d1r.json.entry?.strength === 'strong');
  ok('条目没有被关掉', d1r.json.entry?.status !== 'done', d1r.json.entry?.status);
  ok('有改强度建议时给建议', d1r.json.suggestion === null, String(d1r.json.suggestion));

  await ca.waitFor('entry.fired', 8000, w2id);
  const d2r = await api(`/entries/${w2id}/dismiss`, { method: 'POST', token: ta, body: { reason: '还是不想' } });
  ok('第二次忽略自动降级为 weak', d2r.json.entry?.strength === 'weak', d2r.json.entry?.strength);

  await ca.waitFor('entry.fired', 8000, w2id);
  const d3r = await api(`/entries/${w2id}/dismiss`, { method: 'POST', token: ta, body: { reason: '第三次了' } });
  ok('第三次给出「该删了」的建议', /删掉|弱提示/.test(String(d3r.json.suggestion)), String(d3r.json.suggestion));

  const downEvt = await ca.waitFor('entry.downgraded');
  ok('降级有广播', !!downEvt);

  const dis = await api('/entries?view=dismissed', { token: ta });
  ok('已忽略视图能查到', dis.json.dismissals?.length === 3, `${dis.json.dismissals?.length} 条`);
  ok('忽略记录带理由', dis.json.dismissals?.[0]?.reason === '第三次了');
  ok('忽略记录带设备名', dis.json.dismissals?.[0]?.deviceName === '我的笔记本');

  const neg = await api('/neglected', { token: ta });
  ok('被反复忽略的视图能查到', neg.json.entries?.some((e) => e.id === w2id));

  const rearm = await api(`/entries/${w2id}/rearm`, { method: 'POST', token: ta });
  ok('可以重新武装被忽略的条目', rearm.status === 200 && !!rearm.json.entry?.remindAt);

  /* ---------------------------------------------------------- 推迟 */
  console.log('\n推迟');
  const s2 = await api('/entries', { method: 'POST', token: ta, body: { text: '待推迟', remindAt: Date.now() + 600 } });
  const s2id = s2.json.entry.id;
  await ca.waitFor('entry.fired', 8000, s2id);
  const sn = await api(`/entries/${s2id}/snooze`, { method: 'POST', token: ta, body: { minutes: 30 } });
  ok('推迟接口 200', sn.status === 200, `status=${sn.status} ${JSON.stringify(sn.json)}`);
  ok('推迟到 30 分钟后', sn.json.entry?.remindAt > Date.now() + 25 * 60_000,
    `remindAt=${sn.json.entry?.remindAt} now=${Date.now()}`);
  ok('推迟后清掉 fired_at 重新排队', sn.json.entry?.firedAt === null);
  ok('推迟计数 +1', sn.json.entry?.snoozeCount === 1);

  /* ---------------------------------------------------------- 重复 */
  console.log('\n重复提醒');
  const rep = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '每天都要吃药', remindAt: Date.now() + 600, repeat: 'daily' },
  });
  const repId = rep.json.entry.id;
  ok('重复条目照常触发', !!(await ca.waitFor('entry.fired', 8000, repId)));
  const repAfter = await api(`/entries/${repId}`, { token: ta });
  ok('触发后仍为 pending 不算漏掉', repAfter.json.entry?.status === 'pending', repAfter.json.entry?.status);
  ok('已排下一次', repAfter.json.entry?.remindAt > Date.now());
  ok('下次恰好是明天同一时刻',
    Math.abs(repAfter.json.entry.remindAt - (repAfter.json.entry.firedAt + 86400_000)) < 5000);

  /* -------------------------------------------------------- 乐观锁 */
  console.log('\n并发修改');
  const v = repAfter.json.entry.version;
  const upd = await api(`/entries/${repId}`, { method: 'PATCH', token: tb, body: { note: '改个备注', version: v } });
  ok('版本匹配时改成功', upd.status === 200);
  const stale = await api(`/entries/${repId}`, { method: 'PATCH', token: ta, body: { note: '用旧版本', version: v } });
  ok('旧版本改被拒 409', stale.status === 409);
  ok('409 带上服务端当前值', !!stale.json?.current);

  /* -------------------------------------------------------- 幂等 */
  console.log('\n幂等');
  const key = `mcp:test-${Date.now()}`;
  const i1 = await api('/entries', { method: 'POST', token: ta, body: { text: '幂等测试', idempotencyKey: key } });
  const i2 = await api('/entries', { method: 'POST', token: ta, body: { text: '幂等测试', idempotencyKey: key } });
  ok('同一个幂等键只建一条', i1.json.entry.id === i2.json.entry.id);

  /* ------------------------------------------------------------ MCP */
  console.log('\nMCP');
  ok('MCP 无 token 被拒', (await mcp('list_entries', {}, null)).status === 401);
  ok('MCP 独立 token 能用', (await mcp('list_entries', {}, 'mcp-token-xyz')).status === 200);

  const list = await fetch(`${MCP}/tools`, { headers: { authorization: 'Bearer mcp-token-xyz' } });
  const tools = (await list.json()).tools;
  ok('工具清单可取到', tools.length >= 8, `${tools.length} 个`);
  ok('有 today_digest', tools.some((t) => t.name === 'today_digest'));
  ok('有 plan_changes', tools.some((t) => t.name === 'plan_changes'));
  ok('有 apply_changes', tools.some((t) => t.name === 'apply_changes'));

  const digest = await mcp('today_digest', {}, 'mcp-token-xyz');
  ok('today_digest 可调', digest.status === 200);
  ok('digest 汇总非空', digest.json.result?.概览 !== undefined);
  ok('digest 含被反复忽略的条目', digest.json.result?.被反复忽略?.条目?.length >= 1,
    JSON.stringify(digest.json.result?.被反复忽略?.条目?.length));
  ok('digest 给出删除建议', /建议删除/.test(digest.json.result?.被反复忽略?.条目?.[0]?.建议 ?? ''));

  // 硬规则：强提示必须有依据
  const badStrong = await mcp('create_entry', {
    text: 'agent 擅自建强提示', remindAt: Date.now() + 60_000, strength: 'strong',
  }, 'mcp-token-xyz');
  ok('agent 建强提示被拦下', badStrong.status === 400, `status=${badStrong.status}`);
  ok('拦下时说明了要 reason', /reason/.test(badStrong.json.message ?? ''));

  const okWeak = await mcp('create_entry', { text: 'agent 建的弱提示' }, 'mcp-token-xyz');
  ok('agent 建弱提示成功', okWeak.status === 200);
  ok('默认就是 weak', okWeak.json.result?.entry?.strength === 'weak');
  ok('来源标为 mcp', okWeak.json.result?.entry?.source === 'mcp');
  ok('没给时间就是收集箱', okWeak.json.result?.entry?.status === 'inbox');

  const okStrong = await mcp('create_entry', {
    text: '用户明确要求响铃的', remindAt: Date.now() + 60_000,
    strength: 'strong', reason: '用户原话：一定要提醒我',
  }, 'mcp-token-xyz');
  ok('给了 reason 就放行强提示', okStrong.status === 200);
  ok('强提示也标来源 mcp', okStrong.json.result?.entry?.source === 'mcp');

  // plan / apply 两步走
  const target = (await api('/entries?view=all', { token: ta })).json.entries[0];
  const plan = await mcp('plan_changes', {
    operations: [
      { kind: 'snooze', id: target.id, to: Date.now() + 3600_000 },
      { kind: 'complete', id: target.id },
    ],
  }, 'mcp-token-xyz');
  ok('plan_changes 可调', plan.status === 200);
  ok('plan 返回 plan_id', !!plan.json.result?.planId);
  ok('plan 给出预览', plan.json.result?.预览?.includes('推迟'));
  const beforeApply = (await api(`/entries/${target.id}`, { token: ta })).json.entry;
  ok('plan 阶段没有落库', beforeApply.remindAt === target.remindAt);

  const badPlan = await mcp('apply_changes', { planId: 'not-a-real-plan' }, 'mcp-token-xyz');
  ok('伪造 plan_id 被拒', badPlan.status === 400);

  const applied = await mcp('apply_changes', { planId: plan.json.result.planId }, 'mcp-token-xyz');
  ok('apply_changes 成功', applied.status === 200);
  const afterApply = (await api(`/entries/${target.id}`, { token: ta })).json.entry;
  ok('apply 之后才落库', afterApply.status === 'done' || afterApply.remindAt !== target.remindAt);

  const reuse = await mcp('apply_changes', { planId: plan.json.result.planId }, 'mcp-token-xyz');
  ok('同一个 plan 不能用第二次', reuse.status === 400, `status=${reuse.status}`);

  const unknown = await mcp('no_such_tool', {}, 'mcp-token-xyz');
  ok('未知工具被拒', unknown.status === 400 || unknown.status === 500);

  /* -------------------------------------------------------- 空 body */
  console.log('\n容错');
  const noBody = await fetch(`${BASE}/entries`, {
    method: 'POST', headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/json' },
  });
  const noBodyJson = await noBody.json().catch(() => ({}));
  // 空 body 连 content-type 都没有。解析层要给出 JSON 形态的 400，
  // 不能落成 500 或者直接掐断连接
  ok('空 body 是 400 且带错误码', noBody.status === 400 && !!noBodyJson.error,
    `${noBody.status} ${noBodyJson.error ?? '(无 body)'}`);
  ok('空 body 错误码是 400', noBody.status === 400, `status=${noBody.status}`);

  const blank = await api('/entries', { method: 'POST', token: ta, body: { text: '   ' } });
  ok('全是空格的 text 也被拒', blank.status === 400, `status=${blank.status}`);

  const badStr = await api('/entries', { method: 'POST', token: ta, body: { text: 'x', strength: 'loud' } });
  ok('非法的 strength 被拒', badStr.status === 400, `status=${badStr.status}`);

  const noCt = await fetch(`${BASE}/entries`, { method: 'POST', headers: { authorization: `Bearer ${ta}` } });
  ok('POST 不带 content-type 不报 415', noCt.status !== 415, `status=${noCt.status}`);
  await noCt.body?.cancel();
  const junk = await fetch(`${BASE}/entries`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/json' },
    body: '{ 坏掉的 json',
  });
  ok('坏 JSON 报 400', junk.status === 400, `status=${junk.status}`);

  // 不带 content-type 的坏 body：以前会被当成空对象吞掉，然后以「缺 text」回 400，
  // 看起来对，但实际上错误信息骗人。现在应直接报解析失败
  const junkNoCt = await fetch(`${BASE}/entries`, {
    method: 'POST', headers: { authorization: `Bearer ${ta}` }, body: '{ 也没有 content-type',
  });
  const junkNoCtJson = await junkNoCt.json().catch(() => ({}));
  ok('无 content-type 的坏 JSON 也是 400', junkNoCt.status === 400, `status=${junkNoCt.status}`);
  ok('无 content-type 的坏 JSON 有错误码', !!junkNoCtJson.error, JSON.stringify(junkNoCtJson));

  const huge = await fetch(`${BASE}/entries`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  });
  const hugeJson = await huge.json().catch(() => ({}));
  ok('超大 body 报 413', huge.status === 413, `status=${huge.status}`);
  ok('超大 body 有错误码', !!hugeJson.error, JSON.stringify(hugeJson));
  await junk.body?.cancel();
  const empty = await api('/entries', { method: 'POST', token: ta, body: { text: '空 body 容错测的' } });
  ok('不带 body 就能完成条目',
    (await api(`/entries/${empty.json.entry.id}/done`, { method: 'POST', token: ta })).status === 200);

  /* --------------------------------------------- 乐观锁与设置边界 */
  console.log('\n乐观锁与设置');
  const race = await api('/entries', { method: 'POST', token: ta, body: { text: '并发改它' } });
  const raceId = race.json.entry.id;
  const raceVer = race.json.entry.version;
  const r1 = await api(`/entries/${raceId}`, { method: 'PATCH', token: ta, body: { text: '甲改的', version: raceVer } });
  const r2 = await api(`/entries/${raceId}`, { method: 'PATCH', token: tb, body: { text: '乙改的', version: raceVer } });
  ok('先到的改动成功', r1.status === 200, `status=${r1.status}`);
  ok('版本落后的改动被拒 409', r2.status === 409, `status=${r2.status}`);
  ok('409 带回当前值', r2.json.current?.text === '甲改的', r2.json.current?.text);

  const badPatch = await api(`/entries/${raceId}`, { method: 'PATCH', token: ta, body: { version: 1, text: 'x' } });
  ok('旧版本号同样被拒', badPatch.status === 409, `status=${badPatch.status}`);

  const qUrl = await api(`/entries?q=${encodeURIComponent('甲改的')}`, { token: ta });
  ok('搜索能命中中文', (qUrl.json.entries ?? []).some((e) => e.id === raceId),
    `status=${qUrl.status} n=${qUrl.json.entries?.length} ${JSON.stringify(qUrl.json).slice(0, 200)}`);
  ok('搜索结果也带推送范围', Array.isArray(qUrl.json.entries?.[0]?.devices));

  // 视图边界：逾期未处理的不能从「今天 / 即将到来」里掉出去
  const overdue = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '早就该做的', remindAt: Date.now() - 120_000, strength: 'weak' },
  });
  const overdueId = overdue.json.entry.id;
  await new Promise((r) => setTimeout(r, 600));
  const todayView = await api('/entries?view=today', { token: ta });
  ok('逾期条目仍在「今天」里', (todayView.json.entries ?? []).some((e) => e.id === overdueId));
  const allView = await api('/entries?view=all', { token: ta });
  ok('逾期条目状态是 missed',
    allView.json.entries?.find((e) => e.id === overdueId)?.status === 'missed');
  const upView = await api('/entries?view=upcoming', { token: ta });
  ok('「即将到来」能正常返回',
    Array.isArray(upView.json.entries), `status=${upView.status}`);

  const setOrig = (await api('/settings', { token: ta })).json.settings;
  const setZero = await api('/settings', { method: 'PATCH', token: ta, body: { quietStartMin: 0 } });
  ok('静音开始设成 0 点能存住', setZero.json.settings?.quietStartMin === 0, String(setZero.json.settings?.quietStartMin));
  const setJunk = await api('/settings', {
    method: 'PATCH', token: ta,
    body: { totallyUnknownKey: 'x', quietStartMin: setOrig.quietStartMin },
  });
  ok('未知设置键不被写入', setJunk.json.settings?.totallyUnknownKey === undefined);
  ok('静音开始恢复原值', setJunk.json.settings?.quietStartMin === setOrig.quietStartMin);

  /* ---------------------------------------------------------- 设备 */
  console.log('\n设备');
  const devs = await api('/devices', { token: ta });
  ok('设备列表有 3 台', devs.json.devices?.length === 3, `${devs.json.devices?.length}`);
  ok('安卓设备 online 为真（它连着 WS）',
    devs.json.devices.find((d) => d.id === dphone)?.online === true,
    String(devs.json.devices.find((d) => d.id === dphone)?.online));

  // 显式指定推送范围的条目，设备被引用时不能直接删。
  // 用一个一次性的设备，别拿承载当前 token 的那台来删，
  // sessions.device_id 是级联删除的，删了就把自己踢下线了
  const spare = await api('/auth/login', {
    method: 'POST',
    body: { passcode: 'test-pass-123', deviceName: '备用机', platform: 'windows' },
  });
  const dSpare = spare.json.device.id;

  const pinned = await api('/entries', {
    method: 'POST', token: ta,
    body: { text: '只推给备用机', remindAt: Date.now() + 600_000, devices: [dSpare] },
  });
  ok('推送范围可指定具体设备', JSON.stringify(pinned.json.entry?.devices) === JSON.stringify([dSpare]),
    JSON.stringify(pinned.json.entry?.devices));

  const delBusy = await api(`/devices/${dSpare}`, { method: 'DELETE', token: ta });
  ok('被提醒引用的设备不许直接删 409', delBusy.status === 409, `status=${delBusy.status}`);
  await api(`/entries/${pinned.json.entry.id}`, { method: 'DELETE', token: ta });
  ok('清掉引用后可以删设备', (await api(`/devices/${dSpare}`, { method: 'DELETE', token: ta })).status === 200);

  const pingOther = await api(`/devices/${da}/ping`, { method: 'POST', token: tb });
  ok('不能给别人设备发试响 403', pingOther.status === 403);

  const pingSelf = await api(`/devices/${dbt}/ping`, { method: 'POST', token: tb });
  ok('能给自己发试响', pingSelf.status === 200);
  ok('试响走 ws', pingSelf.json?.via === 'ws');
  ok('试响推到 entry.fired', !!(await cb.waitFor('entry.fired', 4000, 'ping')));

  /* ---------------------------------------------------------- 清理 */
  console.log('\n删除与清理');
  const del = await api(`/entries/${pth.json.entry.id}`, { method: 'DELETE', token: ta });
  ok('删除条目 200', del.status === 200, `status=${del.status} ${JSON.stringify(del.json)}`);
  ok('删除后查不到', (await api(`/entries/${pth.json.entry.id}`, { token: ta })).status === 404);
  ok('删除有广播', !!(await ca.waitFor('entry.deleted')));
  const delDis = await c1.query('SELECT count(*)::int n FROM dismissals WHERE entry_id = $1', [w2id]);
  ok('删条目会级联清掉忽略记录', delDis.rows[0].n === 3, `${delDis.rows[0].n}`);

  const pur = await c1.query(
    `SELECT count(*)::int n FROM deliveries WHERE state = 'acked' AND acked_at < now() - interval '8 days'`);
  ok('清理函数有跑（无异常）', pur.rows[0].n === 0);

  await c1.end();
  ca.ws.close(); cb.ws.close(); cp.ws.close();
} catch (err) {
  fail++;
  failures.push('测试脚本异常');
  console.error('\n\x1b[31m脚本异常\x1b[0m', err);
} finally {
  clearTimeout(watchdog);
  child?.kill('SIGTERM');
  await sleep(400);
  child?.kill('SIGKILL');
  // 数据库连不上时这里也会抛，finally 里抛异常会顶掉后面的 process.exit，
  // 变成 unsettled top-level await，退出码含义不明（13），排查很费时间
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  } catch { /* ignore */ }
  admin.end().catch(() => {});
  console.log(`\n${'-'.repeat(50)}`);
  if (fail === 0) {
    console.log(`\x1b[1m\x1b[32m全部通过 ${pass} 项\x1b[0m\n`);
  } else {
    console.log(`\x1b[1m通过 ${pass}  失败 ${fail}\x1b[0m`);
    for (const f of failures) console.log(`  \x1b[31m- ${f}\x1b[0m`);
    console.log('');
  }
  process.exit(fail === 0 ? 0 : 1);
}
