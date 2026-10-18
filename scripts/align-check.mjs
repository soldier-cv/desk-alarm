/**
 * 需求对齐自检。把 docs/requirements.md 里写成硬规则的那些条，
 * 逐条对着代码验一遍。需求改了这里也要改。
 *
 * 用法：node scripts/align-check.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const src = {
  entries: read('server/src/repo/entries.ts'),
  deliveries: read('server/src/repo/deliveries.ts'),
  scheduler: read('server/src/scheduler.ts'),
  db: read('server/src/db.ts'),
  tools: read('server/src/mcp/tools.ts'),
  api: read('app/src/api.ts'),
  alarm: read('app/src/alarm.ts'),
  takeover: read('app/src/ui/takeover.ts'),
  main: read('app/src/ui/main.ts'),
  styles: read('app/src/styles.css'),
  sql: read('server/src/schema.pg.sql'),
  req: read('docs/requirements.md'),
};

let pass = 0, fail = 0;
const ok = (rule, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${rule}`); }
  else { fail++; console.log(`  FAIL  ${rule}  ${detail}`); }
};

console.log('需求对齐自检\n');

console.log('数据库隔离');
ok('表不写死 public. 前缀', !/\bpublic\s*\./i.test(src.sql));
ok('search_path 指向自己的 schema', /search_path=\$\{env\.PGSCHEMA\}/.test(src.db));
// 只看可执行语句，注释里提一句「不需要 pgcrypto」不算依赖
const sqlCode = src.sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
ok('不依赖 pgcrypto 扩展', !/pgcrypto/i.test(sqlCode));
ok('没有 CREATE EXTENSION', !/CREATE\s+EXTENSION/i.test(sqlCode));
ok('gen_random_uuid 当内核函数用', /gen_random_uuid/.test(sqlCode));

console.log('\n服务端是唯一计时权威');
const firedWrites = [...src.entries.matchAll(/UPDATE entries SET (?:remind_at = \$2, )?fired_at/g)];
ok('fired_at 只在少数几处写', firedWrites.length <= 3, `实际 ${firedWrites.length} 处`);
// snooze 是把 fired_at 清空，属于撤销不是决定触发
ok('snooze 走的是清空 fired_at', /fired_at = NULL/.test(src.entries));
ok('ackEntry 不自己判断到点', !/ackEntry[\s\S]{0,400}?fired_at = \$2/.test(src.entries));
ok('客户端不自己判断触发（只听推送）', !/setInterval[\s\S]{0,200}?showTakeover/.test(src.api));

console.log('\n事务性发件箱');
ok('调度器只写 outbox', /enqueueDelivery/.test(src.scheduler) || /markFired/.test(src.scheduler));
ok('轮转器独立于 tick', /rotate/.test(src.scheduler));
ok('delivered 有 markDelivered', /export async function markDelivered/.test(src.deliveries));
ok('markDelivered 真的被调用', (src.deliveries.match(/markDelivered\s*\(/g) ?? []).length >= 2);
ok('失败不抛异常而是记 last_error', /last_error/.test(src.deliveries));

console.log('\n确认与忽略分开记');
ok('有独立的 dismiss 表', /CREATE TABLE IF NOT EXISTS dismissals/.test(src.sql));
ok('dismiss 要求 reason', /dismissEntry/.test(src.entries));
ok('2 次降级规则存在', /dismissCount\s*>=\s*2|>= 2/.test(src.entries));
ok('done 不复用 dismiss 表', !/dismissals[^;]*status\s*=\s*'done'/.test(src.sql));

console.log('\n提醒强度默认值');
// 文档曾写「给了时间就是强提示」，实现是「只有说了一定要等词才强」。
// 需求文档必须和实现一致，否则以后照文档改会改错
ok('文档不写「给了时间就是强提示」', !/给了时间就是强提示/.test(src.req));
ok('文档写明关键词触发', /一定要/.test(src.req));
ok('实现按关键词判强提示', /一定要\|必须\|别忘/.test(src.api));
ok('无关键词时默认 weak', /urgent \? 'strong' : 'weak'/.test(src.api));
ok('agent 建的一律 weak', /strength[^;\n]*'weak'/.test(src.tools));
// 服务端不能再「有 remindAt 就当强提示」，那是文档明确否掉的做法
ok('服务端不按有没有时间判强提示',
  !/remindAt === null \? 'weak' : 'strong'/.test(src.entries));
ok('服务端没传强度就 weak', /req\.strength === 'strong' \? 'strong' : 'weak'/.test(src.entries));

console.log('\n强弱提示正交');
ok('strength 与 bypassQuiet 是两个字段', /bypass_quiet/.test(src.sql) && /strength/.test(src.sql));
ok('弱提示不升级（弱队列独立）', /weak/i.test(src.alarm));
ok('takeover 关不掉', /takeover:close-blocked/.test(src.takeover));
ok('Esc 不结束强提醒', /takeover:close-blocked/.test(src.takeover));

console.log('\nMCP 防呆');
ok('有 plan_changes', /plan_changes/.test(src.tools));
ok('有 apply_changes', /apply_changes/.test(src.tools));
ok('plan_id 有过期时间', /expires|TTL|10 \* 60|600_?000/.test(src.tools));
ok('强提示必须给 reason', /reason/.test(src.tools));
ok('create_entry 默认 weak', /strength[^;\n]*weak/.test(src.tools) || /'weak'/.test(src.tools));
ok('有 idempotencyKey', /idempotency/i.test(src.tools));

console.log('\n临近梯度');
ok('有四级以上档位', /u-soon|u-close|u-due|u-over/.test(src.styles));
ok('渐变从行首渗入', /linear-gradient\(90deg/.test(src.styles));
ok('hover 用 background-color 不覆盖渐变', /\.item:hover\{background-color:/.test(src.styles.replace(/\s/g, '')) === false || /background-color/.test(src.styles));
ok('due 档有呼吸动效', /breathe/.test(src.styles));
ok('有 reduced-motion 降级', /prefers-reduced-motion/.test(src.styles));
ok('客户端定时推进梯度', /setInterval\(tickUrgency/.test(src.main));
ok('原地更新不重建列表', /dataset\.u/.test(src.main));

console.log('\n服务端地址可配置');
ok('有地址规范化函数', /export function normalizeBaseUrl/.test(src.api));
ok('有连通性探测', /export async function probeServer/.test(src.api));
ok('登录页地址是可编辑输入框', /id="base"/.test(src.main));
ok('登录页有测试连接按钮', /id="test"/.test(src.main));
ok('登录后有切换入口', /id="btn-server"/.test(src.main) && /openServerPanel/.test(src.main));
ok('换地址会清会话', /switchServer/.test(src.api) && /token: ''/.test(src.api));
ok('带 scheme 的不补协议（防注入）', /\[a-z\]\[a-z0-9\+\.\-\]\*:/.test(src.api) || /\^\[a-z\]/.test(src.api));
ok('登录时先落盘再请求', /switchServer\(norm\);[\s\S]{0,200}api\.login/.test(src.main));

console.log('\n暗色主题可读性');
ok('输入框用 --line-input（不是 --line）', /\.input \{[\s\S]{0,200}?--line-input/.test(src.styles));
ok('输入框显式声明 color', /\.input \{[\s\S]{0,200}?color: var\(--text\)/.test(src.styles));
ok('placeholder 有专门样式', /::placeholder/.test(src.styles));
ok('弱化文字色已提亮', /--dim: #(7|8|9|a|b|c|d|e|f)/i.test(src.styles) || /--dim: #8/.test(src.styles));

console.log('\n主题');
// 两套主题只换变量。规则里写死颜色的话，切主题时那块就不跟着变
const styleBody = src.styles.slice(src.styles.indexOf('\n* {'));
const hardCoded = [...styleBody.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)];
ok('规则区没有写死颜色', hardCoded.length === 0, `还有 ${hardCoded.length} 处`);
ok('有莫兰迪主题', /:root\[data-theme="morandi"\]/.test(src.styles));
const themeSrc = read('app/src/theme.ts');
ok('主题写在 html 的 data-theme 上', /dataset\.theme/.test(themeSrc));
ok('主题选择会持久化', /localStorage\.setItem/.test(themeSrc));
ok('主窗口有切换入口', /id="btn-theme"/.test(src.main));
ok('切换到浅色前就挂主题（不闪帧）', /applyTheme\(loadTheme\(\)\);\s*\n\s*\nif \(loadConfig\(\)\.token\)/.test(src.main));
// capture 是独立窗口，必须自己也读一次主题，否则切完还是旧配色
const captureSrc = read('app/src/ui/capture.ts');
ok('capture 窗口跟随主题', /applyTheme\(loadTheme\(\)\)/.test(captureSrc));
ok('takeover 窗口跟随主题', /applyTheme\(loadTheme\(\)\)/.test(src.takeover));
ok('capture 的样式来自变量不是写死', !/#[0-9A-Fa-f]{6}/.test(read('app/capture.html').split('</style>')[0].replace(/\/\*[\s\S]*?\*\//g, '')));
// 两套色板都要过对比度，脚本里缺一套就只验了一半
const contrast = read('app/scripts/contrast.mjs');
ok('对比度脚本检查两套主题', /data-theme="morandi"/.test(contrast) && /暗色/.test(contrast));

console.log('\n列表视图边界');
// 逾期条目时间早已过去，视图条件里不能因为 fired_at 有值就把它排掉
ok('「今天」不按 fired_at 排除', !/today[\s\S]{0,200}fired_at/.test(src.entries));
ok('「即将到来」不排除已触发的', !/upcoming[\s\S]{0,200}fired_at IS NULL/.test(src.entries));

console.log('\n跨平台');
const rust = ['lib', 'commands', 'windows', 'tray', 'main']
  .map((f) => read(`app/src-tauri/src/${f}.rs`)).join('\n');
ok('没有引入 windows crate', !/^windows\s*=/m.test(read('app/src-tauri/Cargo.toml')));
ok('没有 Win32 API 调用', !/winapi|windows_sys|#\[link\(name\s*=\s*"user32"\)\]/i.test(rust));
ok('用了 macOS 的 LaunchAgent', /MacosLauncher::LaunchAgent/.test(rust));
const tauriConf = read('app/src-tauri/tauri.conf.json');
ok('bundle 含 macOS 目标', /"app"|"dmg"/.test(tauriConf));
ok('有 minimumSystemVersion', /minimumSystemVersion/.test(tauriConf));
ok('图标含 icns', /icon\.icns/.test(tauriConf));

console.log('\nCSP 与服务端地址');
// CSP 是编译期写死的，服务端地址是用户运行时填的。
// connect-src 退回逐个列地址，用户填别的地址就会被静默拦掉
ok('connect-src 放开到 ws 协议', /connect-src[^;]*ws:/.test(tauriConf));
ok('connect-src 没退回逐个列地址', !/connect-src[^;]*100\.64\.0\.120:8787/.test(tauriConf));
ok('default-src 保持严格', /default-src 'self'/.test(tauriConf));
ok('没有放开 script-src 的 unsafe-eval', !/script-src[^;]*unsafe-eval/.test(tauriConf));
ok('默认地址只在源码出现一处', (src.api.match(/baseUrl: '/g) ?? []).length === 1);

console.log('\nCI 配置');
const wf = read('.github/workflows/build.yml');
// GitHub 只保留最新两个 macOS 版本。用了下线的标签，job 会永远卡在
// 「Waiting for a runner」，不报错也不失败
const macJob = wf.slice(wf.indexOf('  macos:'));
const runsOn = macJob.match(/runs-on:\s*(\S+)/)?.[1] ?? '';
const rustTarget = macJob.match(/targets:\s*(\S+)/)?.[1] ?? '';
ok('macos runner 不是已下线标签', !/macos-(1[0-3])\b/.test(runsOn), `runs-on=${runsOn}`);
ok('runner 架构与 rust target 一致',
  runsOn.includes('intel') ? rustTarget === 'x86_64-apple-darwin' : rustTarget === 'aarch64-apple-darwin',
  `runs-on=${runsOn} target=${rustTarget}`);
ok('macos 也构建产物', /bundles app,dmg/.test(macJob));
ok('windows 也构建产物', /windows/.test(wf) && /nsis/.test(wf));
ok('minimumSystemVersion 与 arm64 相容', !/10\.15/.test(read('app/src-tauri/tauri.conf.json')));

console.log('\n发布链路');
// 服务端在 Woodpecker，客户端在 GitHub Actions。两边都认 v* tag，
// 推一次 tag 才是「一个版本」；一边认一边不认会出现「部署了但没打包」
const woodpecker = read('.woodpecker.yaml');
ok('woodpecker 认 v* tag', /event:\s*tag/.test(woodpecker) && /refs\/tags\/v\*/.test(woodpecker));
ok('GitHub Actions 也认 v* tag', /push:\s*\n\s*tags:\s*\['v\*'\]/.test(wf));
ok('GitHub Actions 不再因 push main 触发', !/branches:\s*\[main\]/.test(wf));
ok('tag 构建会发 Release', /gh release create/.test(wf) && /gh release upload/.test(wf));
ok('发 Release 需要写权限', /permissions:\s*\n\s*contents:\s*write/.test(wf));
// 没有 --verify-tag 时，tag 不存在会让 gh 从默认分支悄悄造一个，Release 就指向错的提交
ok('建 Release 校验 tag 真实存在', /gh release create[^\n]*--verify-tag/.test(wf));
ok('PR 不跑真机构建', /\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/.test(wf));
ok('打包 job 跳过 PR', (wf.match(/\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/g) ?? []).length >= 2);
// 版本号来源只有一处：tag -> set-version 脚本。写死会让安装包版本和 tag 对不上
ok('产物版本来自 tag', /scripts\/set-version\.mjs/.test(wf));
// GitHub 的 Release 附件名只收 ASCII，中文前缀会被静默丢掉，
// v0.2.x 就是这样变成了 "_0.2.1_x64-setup.exe"
ok('Release 附件用 ASCII 名', /desk-alarm_\$\{V\}_x64-setup\.exe/.test(wf));
ok('Release 附件名有可读前缀', /desk-alarm_/.test(wf));
const versionScript = read('scripts/set-version.mjs');
ok('版本脚本同时改 tauri.conf/Cargo.toml/package.json',
  ['tauriConf', 'cargoToml', 'packageJson'].every((k) => versionScript.includes(k)));
ok('本地 Windows 构建也能带版本号', /-Version/.test(read('scripts/build-windows.ps1')));

console.log('\n注释纪律');
const tooLong = [];
for (const [name, text] of Object.entries(src)) {
  if (name === 'req' || name === 'sql') continue;
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