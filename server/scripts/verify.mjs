/** v2 端到端验证：API + MCP 全走网关。node scripts/verify.mjs */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8091';
const API = `${BASE}/api/v1`;
const MCP = `${BASE}/api/mcp`;
const USER = 'admin';
const PASS = process.env.ADMIN_PASSWORD ?? 'admin123456';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${n}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${n} ${x}`); }
};

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const mcpCall = (name, args, token) => fetch(`${MCP}/call`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ name, arguments: args }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

console.log(`\n\x1b[1m端到端验证（v2 推进引擎）\x1b[0m ${BASE}\n`);

console.log('健康');
const hz = await fetch(`${BASE}/healthz`).then((r) => r.json());
ok('API 直接对外、健康检查可用', hz?.ok === true && hz?.db === true, JSON.stringify(hz));

console.log('\n管理员初始化');
const setupState = await call('/setup/status');
if (setupState.json.needed) {
  const s = await call('/setup', { method: 'POST', body: {
    username: USER, password: PASS, confirmPassword: PASS,
  } });
  ok('首次初始化管理员', s.status === 201 && !!s.json.token, JSON.stringify(s.json).slice(0, 120));
} else {
  ok('已有管理员，跳过初始化', true);
}

console.log('\n鉴权与设备');
const bad = await call('/auth/login', { method: 'POST', body: { username: USER, password: 'nope', deviceName: 'x', platform: 'windows' } });
ok('错误密码被拒', bad.status === 401);
const login = await call('/auth/login', {
  method: 'POST',
  body: { username: USER, password: PASS, deviceName: '验证机', platform: 'windows', machineId: `verify-${Date.now()}`, transport: 'ws' },
});
ok('正确密码能登录', login.status === 200 && !!login.json.token, JSON.stringify(login.json));
const t = login.json.token;

const phone = await call('/auth/login', {
  method: 'POST',
  body: { username: USER, password: PASS, deviceName: '小米手机', platform: 'android', machineId: `verify-phone-${Date.now()}` },
});
ok('安卓设备走 ws 通道（前台服务保活）', phone.json.device?.transport === 'ws');
ok('安卓设备标为未在线', phone.json.device?.online === false);

console.log('\n推进项');
const plan = await call('/pursuits', {
  method: 'POST', token: t,
  body: { text: '端到端验推进项', importance: 2, dueAt: Date.now() + 60_000 },
});
ok('建推进项成功', plan.status === 201 && plan.json.pursuit?.importance === 2);
const noTime = await call('/pursuits', { method: 'POST', token: t, body: { text: '端到端验无时间' } });
ok('无时间默认 active', noTime.json.pursuit?.status === 'active');
const focus = await call('/focus', { token: t });
ok('今日聚焦可用', focus.status === 200 && Array.isArray(focus.json.items));
const stats = await call('/stats/me', { token: t });
ok('我的看板可用', stats.status === 200 && stats.json.today !== undefined);

console.log('\nMCP / Agent 令牌');
const issued = await call('/agent-tokens', { method: 'POST', token: t, body: {
  name: '验证用 Agent', machineId: `verify-agent-${Date.now()}`, scope: 'write',
} });
const AT = issued.json.plain;
ok('Agent 令牌签发成功', !!AT, JSON.stringify(issued.json).slice(0, 120));
ok('登录 token 调不了 MCP', (await mcpCall('today_digest', {}, t)).status === 403);
const tools = await fetch(`${MCP}/tools`, { headers: { authorization: `Bearer ${AT}` } }).then((r) => r.json());
ok('工具清单能取到', (tools.tools?.length ?? 0) >= 8, `${tools.tools?.length}`);
const digest = await mcpCall('today_digest', {}, AT);
ok('today_digest 可调', digest.status === 200 && digest.json.result?.聚焦数 !== undefined);
const high = await mcpCall('create_pursuit', { text: 'x', importance: 3 }, AT);
ok('agent 建高优先级无 reason 被拦', high.status === 400 && /reason|重要性/.test(high.json.message ?? ''));
const normal = await mcpCall('create_pursuit', { text: '端到端 agent 建的推进项' }, AT);
ok('agent 建普通推进项放行（阶段）', normal.status === 200 && !!normal.json.result?.planId);

console.log('\n并发与容错');
const v = plan.json.pursuit.version;
const patched = await call(`/pursuits/${plan.json.pursuit.id}`, { method: 'PATCH', token: t, body: { note: '改过', version: v } });
ok('版本匹配改成功', patched.status === 200);
const stale = await call(`/pursuits/${plan.json.pursuit.id}`, { method: 'PATCH', token: t, body: { note: '旧版本', version: v } });
ok('旧版本改被拒 409', stale.status === 409);
const nb = await fetch(`${API}/pursuits`, { method: 'POST', headers: { authorization: `Bearer ${t}` } });
ok('不带 body 的 POST 返回 400 而不是 500', nb.status === 400, `status=${nb.status}`);
const nbMsg = await nb.json().catch(() => ({}));
ok('错误信息是人话', typeof nbMsg.message === 'string' && nbMsg.message.length > 0, JSON.stringify(nbMsg));
const emptyText = await call('/pursuits', { method: 'POST', token: t, body: { text: '   ' } });
ok('全是空格的 text 也被拒', emptyText.status === 400);
const badImportance = await call('/pursuits', { method: 'POST', token: t, body: { text: 'x', importance: 9 } });
ok('非法的 importance 被拒', badImportance.status === 400);

console.log('\n清理');
const all = await call('/pursuits', { token: t });
for (const p of all.json.pursuits ?? []) {
  await call(`/pursuits/${p.id}`, { method: 'DELETE', token: t });
}
const after = await call('/pursuits', { token: t });
ok('测试数据清干净', (after.json.pursuits ?? []).length === 0, `剩 ${(after.json.pursuits ?? []).length} 条`);

console.log(`\n${'-'.repeat(44)}`);
console.log(fail === 0
  ? `\x1b[1m\x1b[32m全部通过 ${pass} 项\x1b[0m\n`
  : `\x1b[1m通过 ${pass}  失败 ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
