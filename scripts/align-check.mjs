/**
 * 提醒模型对齐自检。把 docs/reminder-model.md 里写成硬规则的那些条，
 * 逐条对着代码验一遍。需求改了这里也要改。
 *
 * 用法：node scripts/align-check.mjs
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const src = {
  pursuits: read('server/src/repo/pursuits.ts'),
  nudges: read('server/src/repo/nudges.ts'),
  drive: read('server/src/drive.ts'),
  policy: read('server/src/policy.ts'),
  scheduler: read('server/src/scheduler.ts'),
  db: read('server/src/db.ts'),
  tools: read('server/src/mcp/tools.ts'),
  stats: read('server/src/repo/stats.ts'),
  api: read('app/src/api.ts'),
  alarm: read('app/src/alarm.ts'),
  takeover: read('app/src/ui/takeover.ts'),
  main: read('app/src/ui/main.ts'),
  styles: read('app/src/styles.css'),
  sql: read('server/src/schema.pg.sql'),
  types: read('shared/types.ts'),
  design: read('docs/reminder-model.md'),
};

let pass = 0, fail = 0;
const ok = (rule, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${rule}`); }
  else { fail++; console.log(`  FAIL  ${rule}  ${detail}`); }
};

console.log('提醒模型对齐自检\n');

console.log('数据库隔离');
ok('表不写死 public. 前缀', !/\bpublic\s*\./i.test(src.sql));
ok('search_path 指向自己的 schema', /search_path=\$\{env\.PGSCHEMA\}/.test(src.db));
const sqlCode = src.sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
ok('不依赖 pgcrypto 扩展', !/pgcrypto/i.test(sqlCode));
ok('没有 CREATE EXTENSION', !/CREATE\s+EXTENSION/i.test(sqlCode));
ok('gen_random_uuid 当内核函数用', /gen_random_uuid/.test(sqlCode));
ok('所有业务表带 user_id', ['pursuits', 'steps', 'followups', 'nudges', 'pursuit_devices']
  .every((t) => new RegExp(`CREATE TABLE IF NOT EXISTS ${t}[\\s\\S]*?user_id`).test(src.sql) ||
    t === 'pursuit_devices')); // 关联表靠父表级联，不单独带 user_id

console.log('\n服务端是唯一计时权威');
ok('fired_at 已由 last_activity 取代，不再有 fired_at 列', !/\bfired_at\b/.test(src.sql));
ok('强弱由引擎算不是客户端', /levelForStrength/.test(src.drive) && /strengthOfImportance/.test(src.types));
ok('客户端只按 nudge.level 表现，不自己判触发', /strengthOfLevel/.test(src.alarm) && !/setInterval[\s\S]{0,200}?showTakeover/.test(src.api));

console.log('\n推进引擎');
ok('有 drive.tick 主循环', /export async function driveTick/.test(src.drive));
ok('有聚焦/情境/到点/跟进四段', /buildFocus/.test(src.drive) && /timeWindow/.test(src.drive) &&
  /dueAt > nowMs\) continue/.test(src.drive) && /followUp/.test(src.drive));
ok('按截止时间排序', /sort\(byDue\)/.test(src.drive) && /function byDue/.test(src.drive));
ok('强弱只有两档', /NudgeLevel = 2 \| 4/.test(src.types) && !/NudgeLevel = 1 \| 2 \| 3/.test(src.types));
ok('强弱是记录的一等字段，不用星标/关键词', /strength: ReminderStrength/.test(src.types) && /p\.strength/.test(src.drive) && /data-strength/.test(read('app/src/ui/capture.ts')));
ok('没填截止时间按强弱给默认值', /defaultDueMs/.test(src.types) && /defaultDueMs/.test(src.pursuits));
ok('到点直接强弹窗或弱通知', /createNudge\(/.test(src.drive) && /channelFor\(strength\)/.test(src.drive));
ok('静音时段延后不降级', /inQuietHours/.test(src.drive) && /if \(quiet\) continue/.test(src.drive));
ok('情境闸门：时间窗/设备在线', /timeWindow/.test(src.drive) && /hub\.isOnline/.test(src.drive));
ok('逾期自动归档并写明原因', /archiveAfterDays/.test(src.drive) && /自动归档/.test(src.drive) &&
  /setStatus\(p\.id, userId, 'archived'\)/.test(src.drive));

console.log('\n跟进是信号不是惩罚');
ok('五种跟进动作（含撤回，无 partial/ignored）',
  /FollowupAction = 'done' \| 'later' \| 'smaller' \| 'archive' \| 'reopen'/.test(src.types));
ok('跟进历史独立表', /CREATE TABLE IF NOT EXISTS followups/.test(src.sql));
ok('不再有忽略降级/建议删除', !/autoDowngradeAfter|neglectedAfter|建议删除/.test(src.drive) &&
  !/dismiss_count/.test(src.sql));
ok('later 改 dueAt', /case 'later'/.test(src.drive) && /dueAt = new Date/.test(src.drive));
ok('smaller 拆步骤', /case 'smaller'/.test(src.drive) && /extraSteps = req\.steps/.test(src.drive));
ok('done 写 completedAt', /completedAt = new Date/.test(src.drive));

console.log('\n打扰账本 = 投递 outbox');
ok('nudges 表是唯一 outbox', /CREATE TABLE IF NOT EXISTS nudges/.test(src.sql) && !/CREATE TABLE IF NOT EXISTS deliveries/.test(src.sql));
ok('有 markDelivered', /markDelivered/.test(src.nudges));
ok('轮转器独立于 tick', /rotate/.test(src.scheduler));
ok('fire_key 去重', /fire_key/.test(src.sql) && /createNudge\(/.test(src.drive) && /due-\$\{p\.dueAt\}/.test(src.drive));
ok('无在线设备时保持 pending 等补发', /hasOnline/.test(src.scheduler) && /markFailed\(n\.id, '设备不在线'\)/.test(src.scheduler));
ok('失败记 last_error 不抛异常', /last_error/.test(src.sql) && /markFailed/.test(src.scheduler));

console.log('\n乐观锁与隔离');
ok('Pursuit 带 version', /version: number/.test(src.types));
ok('写操作校验 version', /VERSION_CONFLICT/.test(src.drive) && /version = version \+ 1/.test(src.pursuits));
ok('所有查询带 user_id', /user_id = \$/.test(src.pursuits));
ok('重复规则校验在路由层', /validRecurrence/.test(read('server/src/routes/pursuits.ts')));

console.log('\nMCP 防呆（agent-first）');
ok('有 plan_changes', /plan_changes/.test(src.tools));
ok('有 apply_changes', /apply_changes/.test(src.tools));
ok('plan_id 有过期时间', /PLAN_TTL_MS/.test(src.tools));
ok('plan 一次性消费', /plans\.delete/.test(src.tools));
ok('强打扰必须给 reason', /needsReason/.test(src.tools) && /reason/.test(src.tools));
ok('只读令牌范围拦截', /READ_TOOLS/.test(src.tools) && /scope === 'read'/.test(src.tools));
ok('涉及 create/decompose/followup/reprioritize/archive', ['create', 'decompose', 'followup', 'reprioritize', 'archive']
  .every((k) => src.tools.includes(k)));

console.log('\n重复规则');
ok('五种频率（无 interval/workdays，新增 quarterly）',
  /freq: 'daily' \| 'weekly' \| 'monthly' \| 'quarterly' \| 'yearly'/.test(src.types));
ok('月末钳位', /setDayClamped|lastDay|Math\.min\(.*getDate/.test(src.policy));
ok('按截止时间排序、逾期在前', /sort\(byDue\)/.test(src.drive) && /function byDue/.test(src.drive));

console.log('\n客户端今日推进');
ok('待办/今日待办分视图', /'todo'/.test(src.api) && /'today'/.test(src.api) && /今日待办/.test(src.main));
ok('今日按截止时间从近到远', /dueAt \!== null && p\.dueAt <= end/.test(src.api));
ok('临近梯度四档可见', /u-soon/.test(src.styles) && /u-close/.test(src.styles) &&
  /u-due/.test(src.styles) && /u-over/.test(src.styles) && /inset 3px 0 0/.test(src.styles));
ok('看板带累计完成数', /completedTotal/.test(src.types) && /completedTotal/.test(src.stats));
ok('跟进动作按钮', /完成|延期|拆小|归档/.test(src.main));
ok('强弱驱动表现', /strengthOfLevel/.test(src.alarm) && /onNotify/.test(src.alarm) && /onTakeover/.test(src.alarm));
ok('强提醒逾期衰减复催（15m/1h/每2h）', /strongRenudgeSlot/.test(src.policy) && /strongRenudgeSlot/.test(src.drive));
ok('弱提醒 +30m 单条与 3h 汇总', /weakSingleSlot/.test(src.policy) && /WEAK_DIGEST_INTERVAL_MS/.test(src.policy) && /pursuit\.overdue_digest/.test(src.drive));
ok('上线 welcome.overdue 补弹', /overdue/.test(read('server/src/routes/stream.ts')) && /msg\.overdue/.test(src.main) && /msg\.overdue/.test(read('app/src/ui/mobile.ts')));
ok('跟进后清理 pending nudge', /ackPendingForPursuit/.test(src.drive) && /pursuit\.status !== 'active'/.test(src.scheduler));
ok('强提醒多条合并逐条处理', /takeoverQueue/.test(src.main) && /items: Pursuit\[\]/.test(src.takeover));
ok('takeover 关不掉', /takeover:close-blocked/.test(src.takeover));
ok('静音时段处理', /inQuietHours/.test(src.alarm));

console.log('\n界面计数与跟进回归');
const mobileSrc = read('app/src/ui/mobile.ts');
ok('行按钮按状态派生', /export function rowActions/.test(src.api) &&
  /rowActions\(p\.status\)/.test(src.main) && /rowActions\(p\.status\)/.test(mobileSrc));
ok('归档可直接删除', /deletePursuit/.test(src.api) && /data-del/.test(src.main) && /data-del/.test(mobileSrc));
ok('底部动作按状态派生', /actionsFor\(p\.status\)\.includes\(a\)/.test(src.main));
ok('全部计数等于各状态之和', /function countAll/.test(src.main) && /Object\.values\(counts\)/.test(src.main));
ok('按钮按状态派生（actionsFor）',
  /actionsFor\(p\.status\)/.test(src.main) && /actionsFor\(p\.status\)/.test(mobileSrc));
ok('跟进只有 HTTP 一条写入路径',
  !/rt\?\.followup\(/.test(src.main) && !/rt\?\.followup\(/.test(mobileSrc));
ok('重复频率显示中文标签',
  /FREQ_LABEL/.test(src.api) && /FREQ_LABEL/.test(src.main) && /FREQ_LABEL/.test(mobileSrc));
ok('重复参数按频率显示，不重复时隐藏',
  /f-rule-extra/.test(src.main) && /fieldsFor\(key\)\.length === 0/.test(src.main));
ok('本机在线状态跟随实时通道', /linkState === 'open'/.test(src.main));
ok('服务端按状态拒绝非法跟进',
  /ACTION_NOT_ALLOWED/.test(src.drive) && /ACTION_NOT_ALLOWED/.test(read('server/src/routes/pursuits.ts')));
ok('全状态可克隆',
  /\/pursuits\/:id\/clone/.test(read('server/src/routes/pursuits.ts')) &&
  /data-act="clone"/.test(src.main) && /mobileClone/.test(mobileSrc));
ok('提醒只有强/弱，用户直接选',
  /strength: ReminderStrength/.test(src.types) && /data-strength=.weak./.test(src.main) &&
  /data-strength=.strong./.test(src.main) && !/data-imp=/.test(src.main));
ok('启动精力已删除',
  !/energy/.test(src.types) && !/Energy/.test(src.api) && !/energy/.test(read('server/src/schema.pg.sql')));
ok('性质不再有 recurring',
  /PursuitNature = 'one_off' \| 'project'/.test(src.types) &&
  !/'recurring'/.test(read('server/src/repo/stats.ts')));
ok('图标复用应用图标', /src-tauri\/icons\/32x32\.png/.test(src.styles) &&
  /src-tauri\/icons\/32x32\.png/.test(read('app/src/about.css')));

console.log('\n服务端地址可配置');
ok('有地址规范化函数', /export function normalizeBaseUrl/.test(src.api));
ok('有连通性探测', /export async function probeServer/.test(src.api));
ok('登录页地址是可编辑输入框', /id="base"/.test(src.main));
ok('登录页有测试连接按钮', /id="test"/.test(src.main));
ok('登录后有切换入口', /id="btn-server"/.test(src.main) && /openServerPanel/.test(src.main));
ok('换地址会清会话', /switchServer/.test(src.api) && /token: ''/.test(src.api));
ok('带 scheme 的不补协议（防注入）', /\[a-z\]\[a-z0-9\+\.\-\]\*:/.test(src.api) || /\^\[a-z\]/.test(src.api));
ok('登录时先落盘再请求', /switchServer\(norm\);[\s\S]{0,500}api\.login/.test(src.main));

console.log('\n暗色主题可读性');
ok('输入框用 --line-input（不是 --line）', /\.input \{[\s\S]{0,200}?--line-input/.test(src.styles));
ok('输入框显式声明 color', /\.input \{[\s\S]{0,200}?color: var\(--text\)/.test(src.styles));
ok('placeholder 有专门样式', /::placeholder/.test(src.styles));

console.log('\n主题');
const tokensCss = read('app/src/tokens.css');
const styleBody = src.styles.slice(src.styles.indexOf('\n* {'));
const mobileStyleBody = read('app/src/styles-mobile.css');
const widgetsStyleBody = read('app/src/widgets.css');
const hardCoded = [styleBody, mobileStyleBody, widgetsStyleBody]
  .flatMap((css) => [...css.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)]);
ok('规则区没有写死颜色', hardCoded.length === 0, `还有 ${hardCoded.length} 处`);
ok('有莫兰迪主题', /:root\[data-theme="morandi"\]/.test(tokensCss));
const themeSrc = read('app/src/theme.ts');
ok('主题写在 html 的 data-theme 上', /dataset\.theme/.test(themeSrc));
ok('主题选择会持久化', /localStorage\.setItem/.test(themeSrc));
ok('主窗口有切换入口', /id="btn-theme"/.test(src.main));
const captureSrc = read('app/src/ui/capture.ts');
ok('capture 窗口跟随主题', /applyTheme\(loadTheme\(\)\)/.test(captureSrc));
ok('takeover 窗口跟随主题', /applyTheme\(loadTheme\(\)\)/.test(src.takeover));
const contrast = read('app/scripts/contrast.mjs');
ok('对比度脚本检查两套主题', /data-theme="morandi"/.test(contrast) && /暗色/.test(contrast));

console.log('\n跨平台');
const rust = ['lib', 'commands', 'windows', 'main']
  .map((f) => read(`app/src-tauri/src/${f}.rs`)).join('\n');
ok('没有引入 windows crate', !/^windows\s*=/m.test(read('app/src-tauri/Cargo.toml')));
ok('没有 Win32 API 调用', !/winapi|windows_sys|#\[link\(name\s*=\s*"user32"\)\]/i.test(rust));
ok('桌面专属插件用 cfg(desktop) 隔开', /#\[cfg\(desktop\)\]/.test(rust));
ok('有移动端入口', /mobile_entry_point/.test(rust));
ok('machine_id 有 android 分支', /target_os\s*=\s*"android"/.test(read('app/src-tauri/src/commands.rs')));
const tauriConf = read('app/src-tauri/tauri.conf.json');
ok('bundle 只有 Windows 目标', /"targets":\s*\[\s*"nsis"\s*\]/.test(tauriConf));
ok('没有 macOS 打包配置', !/dmg|icon\.icns|minimumSystemVersion/.test(tauriConf));

console.log('\nCSP 与服务端地址');
ok('connect-src 放开到 ws 协议', /connect-src[^;]*ws:/.test(tauriConf));
ok('connect-src 没退回逐个列地址', !/connect-src[^;]*100\.64\.0\.120:8787/.test(tauriConf));
ok('default-src 保持严格', /default-src 'self'/.test(tauriConf));
ok('没有放开 script-src 的 unsafe-eval', !/script-src[^;]*unsafe-eval/.test(tauriConf));
ok('默认地址只在源码出现一处', (src.api.match(/baseUrl: '/g) ?? []).length === 1);

console.log('\nCI 配置');
const wf = read('.github/workflows/build.yml');
ok('CI 不含 macOS job', !/^\s*macos:/m.test(wf));
ok('windows 也构建产物', /windows/.test(wf) && /nsis/.test(wf));
ok('latest.json 不含 mac 签名', !/MAC_SIG|darwin-aarch64/.test(wf));

console.log('\n发布链路');
const woodpecker = read('.woodpecker.yaml');
ok('woodpecker 认 v* tag', /event:\s*tag/.test(woodpecker) && /refs\/tags\/v\*/.test(woodpecker));
ok('GitHub Actions 也认 v* tag', /push:\s*\n\s*tags:\s*\['v\*'\]/.test(wf));
ok('GitHub Actions 不再因 push main 触发', !/branches:\s*\[main\]/.test(wf));
ok('tag 构建会发 Release', /gh release create/.test(wf) && /gh release upload/.test(wf));
ok('发 Release 需要写权限', /permissions:\s*\n\s*contents:\s*write/.test(wf));
ok('建 Release 校验 tag 真实存在', /gh release create[^\n]*--verify-tag/.test(wf));
ok('PR 不跑真机构建', /\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/.test(wf));
ok('打包 job 跳过 PR', (wf.match(/\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/g) ?? []).length >= 1);
ok('产物版本来自 tag', /scripts\/set-version\.mjs/.test(wf));
ok('Release 附件用 ASCII 名', /desk-alarm_\$\{V\}_x64-setup\.exe/.test(wf));
ok('版本脚本同时改 tauri.conf/Cargo.toml/package.json', ['tauriConf', 'cargoToml', 'packageJson']
  .every((k) => read('scripts/set-version.mjs').includes(k)));
ok('本地 Windows 构建也能带版本号', /-Version/.test(read('scripts/build-windows.ps1')));

console.log('\n注释纪律');
const tooLong = [];
for (const [name, text] of Object.entries(src)) {
  if (name === 'design' || name === 'sql') continue;
  const lines = text.split('\n');
  let run = 0, start = 0;
  lines.forEach((l, i) => {
    if (/^\s*(\/\*\*|\*|\/\/)/.test(l)) {
      if (run === 0) start = i;
      run++;
    } else {
      if (run > 4) tooLong.push(`${name}:${start + 1}(${run}行)`);
      run = 0;
    }
  });
  if (run > 4) tooLong.push(`${name}:${start + 1}(${run}行)`);
}
ok('没有超过 4 行的注释块', tooLong.length === 0, tooLong.join(', '));

console.log(`\n${'--------------------------------------------'}`);
console.log(fail === 0 ? `全部对齐 ${pass} 项` : `${pass} 过 / ${fail} 项不对齐`);
process.exit(fail === 0 ? 0 : 1);
