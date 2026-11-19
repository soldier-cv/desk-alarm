/** 临时验证：跨用户隔离 + 设备随用户走 + 看板接口。跑完清掉测试用户 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:8091';
const USER = 'admin';
const PASS = process.env.ADMIN_PASSWORD ?? 'admin123456';

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const ok = (n, c, x = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`);
const login = (username, password, machineId) => call('/auth/login', {
  method: 'POST',
  body: { username, password, deviceName: 'iso-check', platform: 'windows', machineId },
});

const setupState = await call('/setup/status');
if (setupState.json.needed) {
  const s = await call('/setup', { method: 'POST', body: {
    username: USER, password: PASS, confirmPassword: PASS,
  } });
  console.log(`${s.status === 201 ? 'PASS' : 'FAIL'}  初始化管理员 ${s.status}`);
}
const admin = await login(USER, PASS, 'iso-admin');
ok('管理员登录', admin.status === 200 && !!admin.json.token, admin.json.error ?? '');

const suffix = Date.now();
const aliceName = `iso-alice-${suffix}`;
const created = await call('/admin/users', {
  method: 'POST', token: admin.json.token,
  body: { username: aliceName, password: 'alice-pass-123', role: 'user' },
});
ok('管理员创建用户', created.status === 201, JSON.stringify(created.json).slice(0, 120));
const aliceId = created.json.user?.id;

const alice = await login(aliceName, 'alice-pass-123', 'iso-machine-1');
ok('新用户登录', alice.status === 200 && !!alice.json.token, JSON.stringify(alice.json).slice(0, 120));

const mine = await call('/entries', {
  method: 'POST', token: alice.json.token,
  body: { text: `隔离测试-${suffix}`, remindAt: Date.now() + 600_000 },
});
ok('Alice 建条目', mine.status === 201, JSON.stringify(mine.json).slice(0, 100));

const adminList = await call('/entries?view=all', { token: admin.json.token });
ok('管理员看不到 Alice 的条目',
  !(adminList.json.entries ?? []).some((e) => e.text === `隔离测试-${suffix}`));

const aliceList = await call('/entries?view=all', { token: alice.json.token });
ok('Alice 看得到自己的条目', (aliceList.json.entries ?? []).some((e) => e.text === `隔离测试-${suffix}`));

const cross = await call(`/entries/${mine.json.entry.id}`, { token: admin.json.token });
ok('管理员按 id 也读不到 Alice 的条目', cross.status === 404, `status=${cross.status}`);

const adminDevices = await call('/devices', { token: admin.json.token });
const aliceDevices = await call('/devices', { token: alice.json.token });
ok('设备列表按用户隔离',
  aliceDevices.json.devices?.length === 1 &&
  !(adminDevices.json.devices ?? []).some((d) => d.id === aliceDevices.json.devices?.[0]?.id));

// 设备随用户走：同一 machine-id 切到另一个用户
const bobName = `iso-bob-${suffix}`;
await call('/admin/users', {
  method: 'POST', token: admin.json.token,
  body: { username: bobName, password: 'bob-pass-123', role: 'user' },
});
const bob = await login(bobName, 'bob-pass-123', 'iso-machine-1');
ok('同机换人登录成功', bob.status === 200, JSON.stringify(bob.json).slice(0, 100));
ok('设备 ID 被复用', bob.json.device?.id === alice.json.device?.id);
const oldToken = await call('/entries', { token: alice.json.token });
ok('旧用户会话在同一设备切换后失效', oldToken.status === 401, `status=${oldToken.status}`);
const bobDevices = await call('/devices', { token: bob.json.token });
ok('设备归属切到新用户', bobDevices.json.devices?.some((d) => d.id === bob.json.device.id));

const overview = await call('/admin/overview', { token: admin.json.token });
ok('看板接口可用', overview.status === 200 && overview.json.entries?.total >= 1,
  JSON.stringify(overview.json).slice(0, 160));

const hz = await fetch(`${BASE}/healthz`).then((r) => r.json());
ok('API 直接对外、健康检查可用', hz?.ok === true && hz?.db === true, JSON.stringify(hz));

// 清理
await call(`/admin/users/${aliceId}`, { method: 'DELETE', token: admin.json.token });
const bobId = (await call('/admin/users', { token: admin.json.token })).json.users
  ?.find((u) => u.username === bobName)?.id;
if (bobId) await call(`/admin/users/${bobId}`, { method: 'DELETE', token: admin.json.token });
console.log('\n完成');
