# DeskAlarm

**agent-first 的自我驱动推进引擎。** 要解决的就一件事：**怕待办放久了忘掉，及时告知**。客户端和服务端分离，多用户、数据隔离。每件事是一个**推进项（Pursuit）**：设个截止时间，拆成小步骤，到点强提醒弹接管窗、弱提醒发通知；agent 可以通过专用 API 全权推进，人在客户端看和确认。

> v2 是架构重构（Entry → Pursuit），数据模型不兼容 v1。升级先 `npm run db:init` 建新表，再 `npm run migrate:v2` 把旧 `entries/dismissals` 迁进来（按用户幂等）。设计动机与算法见 `docs/drive-engine.md`。

## 它长什么样

登录后主窗口三栏：左侧导航、中间列表、右侧详情。顶栏随手记一条，回车就进「待办」；带时间就按时间设截止。

| 视图 | 看什么 |
|---|---|
| 看板 | 连续推进天数、本周完成、累计完成，近 7 天柱状图 |
| 待办 | 所有未完成的事 |
| 今日待办 | 待办里今天到期或已逾期的，按截止时间从近到远 |
| 已完成 / 已归档 | 收尾和清理过的条目 |

列表条目会随截止时间变暖：越近颜色越浓，行首还有一道色条。强提醒到点弹一个关不掉的接管窗，多条合并逐条处理；弱提醒发系统通知。快速记（`Ctrl+Shift+Space`）和接管窗是独立小窗。

> 截图建议：先用顶栏随手记造几条不同截止时间的数据（一条逾期的、一条 15 分钟内、一条今天晚些、一条明天），再截主窗口；强提醒那几条到点后截接管窗。设置页在左下角齿轮，切换服务端点状态栏连接点。

## 当前状态

| 模块 | 状态 |
|---|---|
| 服务端（Node + Fastify + PostgreSQL） | 完成，冒烟 119 项 + 重复日期 24 项全通过 |
| 推进引擎（到点提醒 / 强弱 / 静音 / 跟进 / 自动归档） | 完成 |
| 多用户 / 数据隔离 / 用户管理 | 完成，用户名密码登录，管理员管用户 |
| Agent 令牌（每用户自助签发） | 完成，独立鉴权，只读 / 读写 scope，machine-id 可选 |
| Agent API（`/api/agent`） | 完成，与用户 API 分开，独立鉴权与 scope |
| MCP（stdio + HTTP 双入口，只认 Agent 令牌） | 完成 |
| 看板（个人 + 管理员系统看板） | 完成 |
| Windows 客户端（Tauri 2） | 完成，NSIS 安装包 + 裸 exe |
| Android 客户端 | 代码就绪；原生保活服务收 `pursuit.nudge` 发系统通知，锁屏也能收到。正式签名 APK 由 GitHub Actions 打，见 `docs/android.md` |

## 核心模型

**只有一个时钟：用户设定的截止时间。** 不再按停滞时长猜该催到什么程度。记录只分强提醒 / 弱提醒，由用户直接选；没有「重要性」星标，措辞关键词也不作判定依据。

| 提醒 | 触发 | 表现 | 没填截止的默认值 |
|---|---|---|---|
| 弱提醒 | 到 `dueAt` | 系统通知，1/10/30/60 分钟后每 120 分钟重复 | `now + 1 天` |
| 强提醒 | 到 `dueAt` | 接管窗口，关不掉；多条合并逐条处理 | `now + 2 小时` |

**跟进是信号，不是惩罚。** 低摩擦动作：完成 / 延期 / 拆小 / 归档 / 撤回。拆小会带出该条全部步骤供增删改，一次保存并重设截止时间。步骤在详情面板也能直接改文字、删除。延期可选相对时长或自定义日期时间。静音时段内到点的提醒延后到静音结束再发。截止超过 `archiveAfterDays`（默认 30 天）自动归档并写明原因。详细规则见 `docs/reminder-model.md`。

**服务端是计时的唯一权威。** 客户端用 `serverNow()` 对齐时钟，不自己判「该不该响」。打扰由服务端每 tick 算并写 `nudges`，`last_activity_at` 只由服务端的跟进 / 调度写。投递是事务性 outbox：引擎只写 pending 记录，独立轮转器负责送出；`delivered` 的判定是「通道确认接收」，不是「我发出去了」。

### 临近梯度

列表里唯一的颜色梯度，安静是常态，越接近截止越暖：

| 档位 | 条件 | 表现 |
|---|---|---|
| 无 | > 24 小时 / 已完成 / 已归档 | 无色 |
| soon | ≤ 24 小时 | 行首 12% 强调色，暖灰点 |
| close | ≤ 1 小时 | 20%，暖棕点 |
| due | ≤ 15 分钟 | 30%，强调色点呼吸（2.6 秒一次，只动透明度） |
| over | 已逾期未处理 | 40%，强调色点，标「· X 还没处理」 |

离散四档而不是连续渐变：连续变化在列表里会变成噪声，离散步进才一眼可读。渐变从行首渗入（`linear-gradient(90deg, …)`），和 hover / 选中的背景色是两层，互不覆盖。临近度随时间自己往前走，客户端每 20 秒原地更新行，只动梯度变了的行，滚动位置和选中态不丢。

## 数据库

`desk_alarm` schema 由服务端启动时自动建表，11 张（users / devices / sessions / agent_tokens / pursuits / steps / followups / nudges / pursuit_devices / idempotency / settings），幂等可反复跑。

`general_db` 是共用库，同库还有其它项目的 schema，所以全部表隔离在 `desk_alarm` 这一层，靠 `search_path` 生效，`public` 保持零表。换机器或重建库时需要下面这条，用 `general_db` 的 owner 执行：

```sql
CREATE SCHEMA desk_alarm AUTHORIZATION desk_alarm;
```

`gen_random_uuid()` 从 PostgreSQL 13 起是内核函数，不需要 `pgcrypto` 扩展。

## 起服务

```bash
# 生产（Woodpecker 也走这条）：宿主机 .env 里保留已有数据库地址
docker compose up -d --build

# 本地 Docker Desktop 调试：带 local 覆盖层才会起一个临时 Postgres
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up -d --build
docker compose ps
```

对外只有一个 api 容器，容器监听 8787，对外映射 `WEB_PORT`（默认 8091），客户端直连，没有 nginx 网关。

| 入口 | 地址 |
|---|---|
| API（客户端填这个） | `http://<服务器地址>:8091/api/v1` |
| MCP（只认 Agent 令牌） | `http://<服务器地址>:8091/api/mcp` |
| Agent API | `http://<服务器地址>:8091/api/agent` |
| 健康检查 | `http://<服务器地址>:8091/healthz` |
| 系统看板 | 登录后左侧「系统看板」，仅管理员可见 |

客户端页面源是 `http://tauri.localhost`，与服务端不同源，所以服务端必须回 CORS 头（`server/src/cors.ts`），只放行客户端自己的源；自建 Web 前端要额外把源写进 `CORS_ORIGINS` 后重建容器。

**首次管理员初始化**：全新库里没有账号。第一次启动桌面客户端会出现「初始化管理员」页面，填用户名、密码、确认密码（≥8 位）即可。服务端不再从 env 读管理员密码，`users` 表非空后这个入口自动关闭。后续用户在「设置 → 用户管理」里创建，也能禁用、删除。

**改完 `.env` 必须 `up -d --force-recreate`**，`restart` 不会重新加载环境变量。换端口只动 `.env` 的 `WEB_PORT`。

## 跑客户端

开发模式：

```bash
cd app
npm install
npm run tauri:dev
```

构建：

```powershell
# Windows：默认出 NSIS 安装包；-NoInstaller 只出裸 exe，自用测试快很多
.\scripts\build-windows.ps1
.\scripts\build-windows.ps1 -NoInstaller

# Android 在有 SDK 的机器上（见 docs/android.md）
.\scripts\build-android.ps1                 # universal APK
.\scripts\build-android.ps1 -Target aarch64  # 只打 arm64
```

| 平台 | 产物路径 |
|---|---|
| Windows exe | `app/src-tauri/target/release/deskalarm.exe` |
| Windows 安装包 | `app/src-tauri/target/release/bundle/nsis/*.exe` |
| Android APK | `app/src-tauri/gen/android/app/build/outputs/apk/` |

只有一套前端源码打包成桌面和 Android，**不提供 Web 客户端**——浏览器拿不到 OS 级 machine-id，而设备身份是推送 / 去重 / 令牌机制的基础。桌面专属能力（托盘、热键、开机自启、updater、多窗口）在 Rust 侧用 `#[cfg(desktop)]` 隔开，前端按 `platform()` 隐藏。

应用内升级：顶栏「更新」按钮检查 → 下载 → 签名校验 → 安装 → 重启，Gitee 清单优先、GitHub 降级，详见 `docs/update.md`。启动后一天一次后台检查，发现新版只提示不自动装。

### 连接与登录

登录页最上面是「服务端地址」输入框，带「测试连接」按钮；登录后点顶栏的连接状态也能打开切换面板。填 `host:port` 自动补 `http://`，登录页不预填地址。不同用户之间的提醒、设备、设置完全隔离；同一台机器换人登录时，设备自动跟着新用户走，旧会话立即失效。设备身份用 OS 级 machine-id（Windows 读注册表、Linux 读 `/etc/machine-id`、Android 读系统属性）。

### 配色

默认暗色（近黑底 + 橙），顶栏右侧一键切到**莫兰迪**（暖灰纸底 + 陶土红）。选择会记住，capture 小窗和接管窗口跟着一起变。两套主题只在 `styles.css` 顶部换变量，规则区不允许写字面色值。改色后跑 `cd app && node scripts/contrast.mjs`，脚本会把两套色板都算一遍（正文 4.5:1、控件边界 3:1、实心按钮上的字），不达标非零退出。

### 关于 CSP

`tauri.conf.json` 的 `app.security.csp` 编译期写死。早期把服务端地址逐个列进 `connect-src`，但地址由用户运行时填，静态白名单天然冲突——用户填一个没列过的地址就被拦，表现为「连不上」且看不出原因。现在只放开 `connect-src`（`http: https: ws: wss:`），其余保持严格。本应用只加载本地打包代码，不加载远程脚本，实际风险有限。

## 发版：推一个 tag，两边一起走

服务端和客户端分在两个 CI，但共享同一个 `v*` tag，推一次都走完：

| 内容 | 在哪跑 | 干什么 |
|---|---|---|
| 服务端 | Woodpecker（`.woodpecker.yaml`） | 构建 api 镜像推 registry，`docker compose` 拉起并等健康检查 |
| 客户端 | GitHub Actions（`.github/workflows/build.yml`） | 打 Windows NSIS 安装包 + Android 签名 APK，建 Release 挂上去 |
| Gitee 镜像 | GitHub Actions（`sync-gitee.yml`） | 推 tag 到 Gitee，建同名 Release，同步安装包 / APK |

```bash
git tag v2.0.2
git push origin v2.0.2
```

版本号来源只有 tag 一处，构建时用 tag 里的版本覆盖 `tauri.conf.json` / `Cargo.toml` / `package.json`。GitHub Actions 触发范围：推 `v*` tag 打包发 Release；手动触发填 tag 用于补包；PR 只跑类型检查 / 构建 / 对比度 / URL / 需求对齐自检；push main 不触发。手动填的 tag 必须已推到远端。

## 测试

```bash
cd server
npm run typecheck && npm run build
npm run smoke            # 冒烟 119 项，建临时库跑完删掉
npm run repeat           # 重复日期 24 项，月末 / 季度末钳位
node scripts/verify.mjs  # 端到端验证（需栈起着）
node scripts/e2e-check.mjs   # 联调自检，打已部署的服务端，跑完清数据
npm run isolation        # 跨用户隔离 / 设备随用户走 / 看板接口（需栈起着）

cd ../app
npm test                 # Vitest 18 项
npx tsc --noEmit && npx vite build
node scripts/contrast.mjs # 两套主题对比度

cd ..
node scripts/align-check.mjs  # 需求与代码对齐 114 项
```

`e2e-check` 不建临时库，打的是真实部署，测的是到点通知、跟进、克隆与 MCP 防呆；**它测已部署构建，不是本地刚改的代码**。冒烟测试需要 `127.0.0.1:15432` 的 Postgres，口令等于 `SMOKE_PG_PASSWORD`；本地覆盖层自带这个端口的库：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up -d --build
cd server && SMOKE_PG_PASSWORD=deskalarm npm run smoke
```

## 多设备去重

任意设备处理了推进项，服务端发 `pursuit.followed` 广播，其它正在响的设备立刻停铃。离线设备不丢提醒：nudge 留在 `pending`，重新上线时 `welcome` 带 `missed` 列表并标注迟了多久。重试超时的主动放弃，机会留给补发。推送范围为空的推进项广播给该用户所有在线设备。

## MCP 与 Agent 令牌

见 `docs/mcp.md`。防呆规则：写操作先 `plan_changes` 再 `apply_changes`、`importance=3`(P0) 必须给 `reason`、写之前先 `get_pursuit` 拿最新 `version`。MCP 入口只认**每用户自助签发的 Agent 令牌**，登录 token 会 403。令牌明文只显示一次，服务端只存哈希，随时可撤销，没有全局 `MCP_TOKEN`。

另有独立的 Agent API（`GET/POST/PATCH/DELETE /api/agent/pursuits`、`POST /api/agent/followup`、`POST /api/agent/clone`、`GET /api/agent/focus`、`GET /api/agent/whoami`），只认 Agent 令牌并按 scope 限制读写，所有操作限定在签发用户自己的数据里。

## 目录结构

```
app/src/ui/           main.ts 主视图 / mobile.ts Android / takeover.ts 接管窗 / capture.ts 快速记
app/src/alarm.ts      跟进提醒控制器
app/src/api.ts        HTTP/WS 通信层、解析与乐观锁
app/src/styles.css    两套主题（桌面共用）
app/src/styles-mobile.css  移动端样式
app/src-tauri/src/    commands.rs 原生命令 / windows.rs 窗口行为 / update.rs 升级
app/src-tauri/gen/android/  Android 工程（含原生保活与推送服务）
shared/types.ts       前后端共享契约
server/src/           drive.ts 推进引擎 / policy.ts 算法 / repo/ 持久化 / routes/ 路由 / mcp/ 工具集
server/scripts/       smoke / repeat / verify / e2e-check / isolation-check
docs/                 drive-engine / reminder-model / mcp / mcp-rules / android / update / design-v0.3.0
docker/               api 镜像
docker-compose.local.yml  本地调试覆盖层（临时 Postgres），生产不用
```

## 许可

MIT，见 [LICENSE](LICENSE)。
