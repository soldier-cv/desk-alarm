# v0.3.0 设计：可配置、双看板设备锁定与界面重构

## 目标

把桌面端从「能连能用」补到「可配置、可观测、可锁定、好看、能验证自动更新」；
Android 与桌面共用前端和 Rust 源码，所有新能力必须按 `#[cfg(desktop)]` / `#[cfg(mobile)]` 分层。

## 决策日志

| 编号 | 决定 | 备选 | 理由 |
|---|---|---|---|
| D1 | 锁定保留 WS，只加 `devices.locked` 标记，投递层跳过；解锁后走既有 missed 补发 | 真断 WS / 只本地遮罩 | 断 WS 会丢跨端状态同步；本地遮罩不满足「相当于离线」 |
| D2 | PIN 账号级，服务端只存 scrypt 哈希；改 PIN 要验账号密码；没设 PIN 不允许锁 | 设备级 / 纯本地 | 多设备不用记多个 PIN；服务端可校验解锁，换设备仍能用 |
| D3 | Windows 锁屏→自动锁定且按离线；系统解锁→自动解锁，不重复要 PIN | 解锁仍要 PIN | 系统已验过身份，再要 PIN 是纯摩擦；手动锁定仍必须 PIN |
| D4 | 移动端不提供锁定：切后台/锁屏照常由前台服务保活、WS 不断线；服务端也拒绝移动端锁定请求 | 切后台自动锁定 | 提醒类应用切后台是常态，锁定=离线会让手机完全收不到提醒，场景上是反的 |
| D5 | 「本地日志策略」= 客户端日志级别 / 是否落盘 / 保留天数，Rust 写文件，前端只发关键事件 | 只存 localStorage | 用户要的是能查的本地日志，不是浏览器 console |
| D6 | X 按钮默认改为「退出程序」，设置页可切回「隐藏到托盘」；顶栏托盘按钮和试响按钮移除 | 保持现状 | 用户明确要求；系统标题栏已有最小化 |
| D7 | 普通用户看板按单用户数据算连续守约天数 / 7 天准时率 / 今日状态；admin 看板保留并重构视觉 | 共用一张看板 | 两类用户关心的事不同，且 admin 有跨用户数据 |
| D8 | 设备 IP 在登录时记录到 `devices.last_ip`，只在本人设备列表展示 | 仅会话内内存 | 要能事后看到「上次从哪登的」 |
| D9 | 主题按钮显示**当前**主题，点击切换；tooltip 说明会切到什么 | 显示下一个主题 | 当前显示「莫兰迪」让人以为标错了 |
| D10 | 版本 minor `v0.3.0`，CHANGELOG 同步；tag 先本地建，push 前单独确认 | 直接 push | push tag 会触发 GitHub Release 和 Woodpecker 生产部署 |

## 服务端契约（全部 `/api/v1`，需要登录）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/pin` | `{pin: 4-12位数字, currentPassword?: string}` | `{ok:true}`；已有 PIN 时必须带对账号密码 |
| DELETE | `/pin` | `{currentPassword: string}` | `{ok:true}` |
| POST | `/devices/lock` | `{locked: boolean, pin?: string}` | `{device: Device}`；只作用于当前会话自己的设备；锁定时必须已设 PIN，解锁时 `pin` 必须正确 |
| GET | `/stats/me` | — | `{streakDays, today:{due,done,missed}, week:{due,onTime,rate}, dismissed, days:[{day,due,done,missed}]}` |
| GET | `/settings` / PATCH `/settings` | 既有 | 前端这次真正接上（原来从未调用） |
| GET | `/admin/overview` | 既有 | 仅 admin，重构展示 |

`User` 增加 `hasPin: boolean`（`/auth/whoami` 和登录响应都要带）。
`Device` 增加 `locked: boolean`、`lastIp: string | null`。

数据库：`devices` 加 `locked boolean not null default false`、`last_ip text`；`users` 加 `pin_hash text`。用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 追加在 `schema.pg.sql` 末尾，开机 `migrate()` 幂等执行。

投递改动：`resolveTargets` 不改（锁定设备照样入 outbox）；`takePending` 联 `devices` 过滤 `locked = true`，使提醒堆积但不重试；解锁后 `findMissed` 自然读到这些 pending 并补发。

## 原生层契约

- `set_close_behavior("quit"|"tray")`：持久化到 app data 目录；`CloseRequested` 按它决定退出还是隐藏；`ExitRequested` 拦截只保留托盘模式。
- Windows：`session:locked` / `session:unlocked` 事件，轮询 `OpenInputDesktop`（或同等 API）检测会话锁；`#[cfg(windows)]` 隔离。
- Android：不写 JNI，靠前端生命周期事件；`#[cfg(mobile)]` 不注册托盘/热键/自启/更新。
- `log_event {level,message}` / `get_log_policy` / `set_log_policy {level,enabled,retentionDays}`：写 `%LOCALAPPDATA%/DeskAlarm/logs`，按天分文件，启动时删超期文件。

## 前端结构

- 新增 `View`: `settings`、`mystats`；`dashboard` 改名「系统看板」，仅 admin 可见。
- 侧栏：我的看板 / 设置（常驻）；用户管理作为设置页里的一节（不再藏在服务端面板）。
- 设置页分区：常规（主题、X 行为、开机自启、更新）、提醒（原 7 项服务端设置）、设备与安全（试响、设备列表含 IP、锁定、PIN）、用户管理（admin）、日志（策略 + 打开日志目录）。
- 锁定遮罩：全屏、PIN 输入、错误提示；手动锁定必须 PIN 解锁；系统锁屏自动锁定/解锁跟随系统。
- 解锁成功后主动 `GET /missed` 补发欠账。
- 样式：统一 8px 间距刻度、卡片层级、数字字号；两套主题都跑 `node scripts/contrast.mjs`。

## 验收

- `cd server && npm run smoke && npm run e2e`（含新增锁定/跳过投递断言）
- `cd app && npx tsc --noEmit && npx vite build`
- `cd app && cargo check --manifest-path src-tauri/Cargo.toml`（Windows 目标）
- `cd app && node scripts/contrast.mjs`
- 端到端：锁屏设备不再收到投递，解锁后收到 missed 补发；换账号看不到别人数据；admin 能管理用户；清空库后能重新初始化。
