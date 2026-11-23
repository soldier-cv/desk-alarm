/**
 * v2 联调自检：连已部署的服务端，跑一遍推进引擎关键链路。
 * 写操作造的数据跑完删掉。用法：node scripts/e2e-check.mjs
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8091';
const USER = 'admin';
const PASSCODE = process.env.ADMIN_PASSWORD ?? 'admin123456';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* 还没好 */ }
    await sleep(100);
  }
  ok(label, false);
  return false;
}
const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const mcp = (name, args, token) => fetch(`${BASE}/api/mcp/call`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name, arguments: args }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

console.log(`v2 联调自检  ${BASE}\n`);

console.log('健康检查');
const h = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
ok('healthz 可达', h?.ok === true, JSON.stringify(h));
ok('db 连接正常', h?.db === true);

console.log('\n管理员初始化');
const setupState = await api('/setup/status');
if (setupState.json.needed) {
  const s = await api('/setup', { method: 'POST', body: {
    username: USER, password: PASSCODE, confirmPassword: PASSCODE,
  } });
  ok('首次初始化管理员', s.status === 201, JSON.stringify(s.json).slice(0, 120));
}

console.log('\n鉴权');
const bad = await api('/auth/login', { method: 'POST', body: { username: USER, password: 'wrong-one', deviceName: 'x' } });
ok('错误密码被拒', bad.status === 401 || bad.status === 403, `got ${bad.status}`);
const login = await api('/auth/login', {
  method: 'POST',
  body: { username: USER, password: PASSCODE, deviceName: '联调机', platform: 'windows', machineId: `e2e-${Date.now()}` },
});
ok('登录成功', login.status === 200 && !!login.json.token, JSON.stringify(login.json).slice(0, 120));
const t = login.json.token;

console.log('\n推进项 + 拆解 + 跟进');
const made = await api('/pursuits', {
  method: 'POST', token: t,
  body: { text: `联调-${Date.now()}`, nature: 'project', importance: 2, steps: ['第一步', '第二步'] },
});
const pid = made.json.pursuit?.id;
ok('建推进项含步骤', made.status === 201 && made.json.pursuit?.steps?.length === 2);

const decomposed = await api(`/pursuits/${pid}/steps`, {
  method: 'POST', token: t, body: { text: '第三步' },
});
ok('加步骤成功', decomposed.json.pursuit?.steps?.length === 3);

const firstStep = decomposed.json.pursuit.steps[0];
const stepped = await api(`/steps/${firstStep.id}`, {
  method: 'PATCH', token: t, body: { state: 'done' },
});
ok('勾选步骤推进', stepped.json.pursuit?.progress > 0);

const followed = await api(`/pursuits/${pid}/followup`, {
  method: 'POST', token: t,
  body: { action: 'later', to: Date.now() + 3_600_000, version: stepped.json.pursuit.version },
});
ok('跟进 later 成功', followed.status === 200, `status=${followed.status} ${JSON.stringify(followed.json).slice(0, 100)}`);

console.log('\n聚焦 + 看板');
const focus = await api('/focus', { token: t });
ok('聚焦接口可用', focus.status === 200 && Array.isArray(focus.json.items));
const stats = await api('/stats/me', { token: t });
ok('我的看板可用', stats.status === 200 && stats.json.today !== undefined);

console.log('\nMCP 防呆');
const issued = await api('/agent-tokens', {
  method: 'POST', token: t,
  body: { name: `联调 agent-${Date.now()}`, machineId: `e2e-agent-${Date.now()}`, scope: 'write' },
});
const AT = issued.json.plain;
ok('签发 Agent 令牌', !!AT, JSON.stringify(issued.json).slice(0, 100));
ok('登录 token 调不了 MCP', (await mcp('today_digest', {}, t)).status === 403);
const digest = await mcp('today_digest', {}, AT);
ok('today_digest 可用', digest.status === 200 && digest.json.result?.聚焦数 !== undefined);
const badHigh = await mcp('create_pursuit', { text: 'x', importance: 3 }, AT);
ok('高优先级无 reason 被拦', badHigh.status === 400);
const staged = await mcp('create_pursuit', { text: '联调 agent 建的' }, AT);
ok('普通推进项阶段成功', staged.status === 200 && !!staged.json.result?.planId);
const applied = await mcp('apply_changes', { planId: staged.json.result.planId }, AT);
ok('apply 后落库', applied.status === 200);

console.log('\n重复规则');
const rep = await api('/pursuits', {
  method: 'POST', token: t,
  body: { text: `联调重复-${Date.now()}`, nature: 'recurring', recurrence: { freq: 'daily' }, dueAt: Date.now() - 1000 },
});
ok('重复项到期后自动排下一次', await waitUntil(async () => {
  const r = await api(`/pursuits/${rep.json.pursuit.id}`, { token: t });
  return (r.json.pursuit?.dueAt ?? 0) > Date.now();
}, '重复项排下一次'));

console.log('\n清理');
for (const p of (await api('/pursuits', { token: t })).json.pursuits ?? []) {
  await api(`/pursuits/${p.id}`, { method: 'DELETE', token: t });
}
const after = await api('/pursuits', { token: t });
ok('测试数据清干净', (after.json.pursuits ?? []).length === 0, `剩 ${(after.json.pursuits ?? []).length} 条`);

console.log(`\n${'-'.repeat(44)}`);
console.log(fail === 0
  ? `\x1b[1m\x1b[32m全部通过 ${pass} 项\x1b[0m\n`
  : `\x1b[1m通过 ${pass}  失败 ${fail}\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
