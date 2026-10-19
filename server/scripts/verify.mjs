/** 端到端验证：静态页 + API + MCP 全走网关。node scripts/verify.mjs */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8091';
const API = `${BASE}/api/v1`;
const MCP = `${BASE}/api/mcp`;
const PASS = process.env.DESKALARM_PASSCODE;
if (!PASS) {
  console.error('缺少 DESKALARM_PASSCODE：verify 打的是真实部署，没口令验不了鉴权链路');
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${n}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${n} ${x}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

console.log(`\n\x1b[1m端到端验证\x1b[0m ${BASE}\n`);

console.log('静态与健康');
const root = await fetch(`${BASE}/`).then((r) => r.status);
ok('网关根路径出静态页', root === 200, `status=${root}`);
const hz = await fetch(`${BASE}/healthz`).then((r) => r.json());
ok('网关健康检查透传到 API', hz?.ok === true && hz?.db === true, JSON.stringify(hz));

console.log('\n鉴权与设备');
const bad = await call('/auth/login', { method: 'POST', body: { passcode: 'nope', deviceName: 'x', platform: 'windows' } });
ok('错误口令被拒', bad.status === 401);
const login = await call('/auth/login', {
  method: 'POST',
  body: { passcode: PASS, deviceName: '验证机', platform: 'windows', transport: 'ws' },
});
ok('正确口令能登录', login.status === 200 && !!login.json.token, JSON.stringify(login.json));
const t = login.json.token;

const phone = await call('/auth/login', {
  method: 'POST',
  body: { passcode: PASS, deviceName: '小米手机', platform: 'android', transport: 'fcm', pushToken: 'x' },
});
ok('安卓设备能注册 fcm 通道', phone.json.device?.transport === 'fcm');
ok('安卓设备标为未在线', phone.json.device?.online === false);

console.log('\n强弱提示');
const weak = await call('/entries', {
  method: 'POST', token: t,
  body: { text: '端到端验弱提示', remindAt: Date.now() + 1500, strength: 'weak' },
});
ok('弱提示保存成功', weak.status === 201 && weak.json.entry.strength === 'weak');
const inbox = await call('/entries', { method: 'POST', token: t, body: { text: '端到端验收集箱' } });
ok('收集箱条目默认 weak', inbox.json.entry.strength === 'weak' && inbox.json.entry.status === 'inbox');

const dismissedView = await call('/entries?view=dismissed', { token: t });
ok('已忽略视图可访问', Array.isArray(dismissedView.json.dismissals));
const neglected = await call('/neglected', { token: t });
ok('被反复忽略视图可访问', Array.isArray(neglected.json.entries));

console.log('\nMCP');
const mh = { authorization: `Bearer ${t}` };
const tools = await fetch(`${MCP}/tools`, { headers: mh }).then((r) => r.json());
ok('工具清单能取到', (tools.tools?.length ?? 0) >= 8, `${tools.tools?.length}`);
const digest = await mcpCall('today_digest', {}, t);
ok('today_digest 可调', digest.status === 200 && !!digest.json.result?.概览);
const strong = await mcpCall('create_entry', { text: 'x', remindAt: Date.now() + 60_000, strength: 'strong' }, t);
ok('agent 建强提示被拦', strong.status === 400 && /reason/.test(strong.json.message ?? ''));
const weakm = await mcpCall('create_entry', { text: '端到端 agent 建的弱提示' }, t);
ok('agent 建弱提示放行', weakm.status === 200 && weakm.json.result?.entry?.strength === 'weak');

console.log('\n幂等与并发');
const key = `mcp:e2e-${Date.now()}`;
const i1 = await call('/entries', { method: 'POST', token: t, body: { text: '端到端幂等', idempotencyKey: key } });
const i2 = await call('/entries', { method: 'POST', token: t, body: { text: '端到端幂等', idempotencyKey: key } });
ok('同一个幂等键只建一条', i1.json.entry.id === i2.json.entry.id);
const v = weak.json.entry.version;
await call(`/entries/${weak.json.entry.id}`, { method: 'PATCH', token: t, body: { note: '改过', version: v } });
const stale = await call(`/entries/${weak.json.entry.id}`, { method: 'PATCH', token: t, body: { note: '旧版本', version: v } });
ok('旧版本改被拒 409', stale.status === 409);

console.log('\n空 body 容错');
const nb = await fetch(`${API}/entries`, { method: 'POST', headers: { ...mh } });
ok('不带 body 的 POST 返回 400 而不是 500', nb.status === 400, `status=${nb.status}`);
const nbMsg = await nb.json().catch(() => ({}));
ok('错误信息是人话', typeof nbMsg.message === 'string' && nbMsg.message.length > 0, JSON.stringify(nbMsg));
const emptyText = await call('/entries', { method: 'POST', token: t, body: { text: '   ' } });
ok('全是空格的 text 也被拒', emptyText.status === 400);
const badStrength = await call('/entries', { method: 'POST', token: t, body: { text: 'x', strength: 'loud' } });
ok('非法的 strength 被拒', badStrength.status === 400);

console.log('\n清理');
// 清干净这一轮造的全部条目，不靠列表点名，避免漏
const all = await call('/entries?view=all&limit=500', { token: t });
for (const e of all.json.entries ?? []) {
  await call(`/entries/${e.id}`, { method: 'DELETE', token: t });
}
const after = await call('/entries?view=all', { token: t });
ok('测试数据清干净', after.json.entries.length === 0, `剩 ${after.json.entries.length} 条`);

console.log(`\n${'-'.repeat(44)}`);
console.log(fail === 0
  ? `\x1b[1m\x1b[32m全部通过 ${pass} 项\x1b[0m\n`
  : `\x1b[1m通过 ${pass}  失败 ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
