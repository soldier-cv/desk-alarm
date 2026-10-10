/**
 * 真机联调自检。连本机 Docker 里的服务端 + 88 的真库，跑一遍关键链路。
 * 用法：node scripts/e2e-check.mjs
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const PASSCODE = process.env.DESKALARM_PASSCODE ?? 'sk-desk-2026';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
};

console.log(`联调自检  ${BASE}\n`);

console.log('健康检查');
const h = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
ok('healthz 可达', h?.ok === true, JSON.stringify(h));
ok('连的是 88 真库', h?.schema === 'desk_alarm', `schema=${h?.schema}`);
ok('db 连接正常', h?.db === true);

console.log('\n鉴权');
const bad = await api('/auth/login', { method: 'POST', body: { passcode: 'wrong-one', deviceName: 'x' } });
ok('错误口令被拒', bad.status === 401 || bad.status === 403, `got ${bad.status}`);

const login = await api('/auth/login', {
  method: 'POST',
  body: { passcode: PASSCODE, deviceName: '联调自检', kind: 'desktop', platform: 'windows' },
});
ok('正确口令能登录', login.status === 200 && !!login.json.token, JSON.stringify(login.json).slice(0, 120));
const token = login.json.token;
if (!token) { console.log('\n登录失败，后面没法测'); process.exit(1); }

const dev = await api('/devices', { token });
const me = dev.json.devices?.find((d) => d.name === '联调自检');
ok('设备已注册', !!me, JSON.stringify(dev.json).slice(0, 120));

console.log('\n建条目与调度');
const remindAt = Date.now() + 8000;
const created = await api('/entries', {
  method: 'POST', token,
  body: { text: '联调自检：8 秒后该响', strength: 'strong', reason: '验证调度器', remindAt, devices: ['*'] },
});
const entryId = created.json.entry?.id;
ok('强提示能建', created.status === 200 || created.status === 201, JSON.stringify(created.json).slice(0, 120));
ok('强提示要求 reason 时给了就放行', created.json.entry?.strength === 'strong');

// HTTP 建条目不强制 reason（客户端界面已经问过用户了）。
// 强制 reason 是 MCP 侧那条防呆规则，见下面 MCP 段。
const withReason = await api('/entries', {
  method: 'POST', token,
  body: { text: '给了 reason 的强提示', strength: 'strong', reason: '验证', remindAt: Date.now() + 600000, devices: ['*'] },
});
ok('强提示带 reason 能建', withReason.status === 201, `got ${withReason.status}`);
await api(`/entries/${withReason.json.entry?.id}`, { method: 'DELETE', token });

const weak = await api('/entries', { method: 'POST', token, body: { text: '一条弱提示' } });
ok('收集箱条目默认 weak', weak.json.entry?.strength === 'weak');
ok('不定时进收集箱', weak.json.entry?.status === 'inbox');

console.log('\n等待调度器触发（10 秒）');
await new Promise((r) => setTimeout(r, 10000));
const after = await api('/entries?view=today', { token });
const fired = after.json.entries?.find((e) => e.id === entryId);
ok('调度器到点触发', fired?.firedAt != null, `status=${fired?.status} firedAt=${fired?.firedAt}`);
ok('触发后状态是 missed', fired?.status === 'missed', `status=${fired?.status}`);

console.log('\n确认与忽略分开记');
const done = await api(`/entries/${entryId}/done`, { method: 'POST', token });
ok('能标记完成', done.status === 200, JSON.stringify(done.json).slice(0, 140));
ok('完成后状态变 done', done.json.entry?.status === 'done', `status=${done.json.entry?.status}`);

// 忽略要另建一条，因为 done 之后不再适合测忽略
const toIgnore = await api('/entries', {
  method: 'POST', token,
  body: { text: '一条用来测忽略的', strength: 'strong', reason: '验证忽略', remindAt: Date.now() + 600000, devices: ['*'] },
});
const ignoreId = toIgnore.json.entry?.id;
const dismissed = await api(`/entries/${ignoreId}/dismiss`, {
  method: 'POST', token, body: { reason: '这个我故意不做' },
});
ok('能记忽略', dismissed.status === 200, `got ${dismissed.status}`);
ok('忽略带理由被存下', dismissed.json.dismissCount === 1, `count=${dismissed.json.dismissCount}`);
ok('忽略后状态不是 done', dismissed.json.entry?.status !== 'done', `status=${dismissed.json.entry?.status}`);

// 被忽略 2 次应自动降级为弱提示
const toIgnore2 = await api('/entries', {
  method: 'POST', token,
  body: { text: '一条要被忽略两次的', strength: 'strong', reason: '验证降级', remindAt: Date.now() + 600000, devices: ['*'] },
});
const ignoreId2 = toIgnore2.json.entry?.id;
await api(`/entries/${ignoreId2}/dismiss`, { method: 'POST', token, body: { reason: '第一次' } });
const second = await api(`/entries/${ignoreId2}/dismiss`, { method: 'POST', token, body: { reason: '第二次' } });
ok('被忽略 2 次自动降级为弱提示', second.json.entry?.strength === 'weak', `strength=${second.json.entry?.strength}`);
ok('降级后仍待处理（不是 done）', second.json.entry?.status !== 'done', `status=${second.json.entry?.status}`);
ok('被忽略 2 次会给出建议', !!second.json.suggestion, JSON.stringify(second.json).slice(0, 140));

console.log('\nMCP');
const tools = await fetch(`${BASE}/api/mcp/tools`, {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json()).catch(() => null);
ok('工具清单能取', Array.isArray(tools?.tools) && tools.tools.length >= 8, `count=${tools?.tools?.length}`);
const names = (tools?.tools ?? []).map((t) => t.name);
ok('有 today_digest', names.includes('today_digest'), names.join(','));
ok('有 plan_changes', names.includes('plan_changes'), names.join(','));

// MCP 侧强提示必须给 reason，这是给 agent 的防呆规则（HTTP 侧不强制）
const call = async (tool, args) => fetch(`${BASE}/api/mcp/call`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ tool, arguments: args }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })).catch(() => ({ status: 0, json: null }));

const strongNoReason = await call('create_entry', { text: 'agent 建的强提示', strength: 'strong', remindAt: Date.now() + 600000 });
ok('agent 建强提示没 reason 被拦', strongNoReason.status >= 400 || strongNoReason.json?.error, JSON.stringify(strongNoReason.json).slice(0, 140));

console.log('\n清理');
for (const id of [entryId, weak.json.entry?.id, ignoreId, ignoreId2].filter(Boolean)) {
  await api(`/entries/${id}`, { method: 'DELETE', token });
}
const left = await api('/entries?view=all', { token });
ok('测试数据清干净', !(left.json.entries ?? []).some((e) => e.text?.startsWith('联调自检') || e.text === '一条弱提示'));

console.log(`\n${'--------------------------------------------'}`);
console.log(fail === 0 ? `全部通过 ${pass} 项` : `${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);