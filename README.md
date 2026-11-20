# DeskAlarm

到点强提示的桌面工具。客户端与服务端分离，多用户、数据隔离，同一条提醒可指定推送到该用户的多台设备。

## 当前状态

| 模块 | 状态 |
|---|---|
| 服务端（Node + Fastify + PostgreSQL） | 完成，**146 项冒烟 + 23 项网关验证 + 14 项重复日期 + 14 项隔离检查全通过** |
| 强弱提示与忽略记录 | 完成 |
| 多用户 / 数据隔离 / 用户管理 | 完成，用户名密码登录，管理员管用户 |
| Agent 令牌（每用户自助签发） | 完成，独立鉴权，只读/读写 scope，machine-id 可选（云端 agent 可不绑） |
| Agent 专用 API（`/api/agent`） | 完成，与用户 API 分开，独立鉴权与 scope |
| MCP（stdio + HTTP 双入口，只认 Agent 令牌） | 完成 |
| 开发看板（应用内视图 + admin/overview） | 完成 |
| Windows 客户端（Tauri 2） | 完成，NSIS 安装包 + 裸 exe |
| Android 客户端 | 代码就绪、已按移动端 cfg 适配，在有 SDK 的机器上用 `scripts/build-android.ps1` 构建，见 `docs/android.md` |

## 数据库授权

已有数据库里 `desk_alarm` schema 由服务端启动时自动建表（共 10 张：users / devices / sessions / agent_tokens / entries / idempotency / entry_devices / deliveries / dismissals / settings），幂等可反复跑。生产沿用宿主机 `.env` 里既有的数据库和库名，没有改名。

`general_db` 是共用库，同库里还有其它项目的 schema，所以全部表隔离在 `desk_alarm` 这一层，靠 `search_path` 生效，`public` 保持零表。换机器或重建库时需要下面这条，用 `general_db` 的 owner 执行：

```sql
CREATE SCHEMA desk_alarm AUTHORIZATION desk_alarm;
```

只建 schema，不动 `public`，不影响同库其它项目。

## 架构

```
┌──────────────┐   HTTP + WebSocket   ┌──────────────┐        ┌──────────────┐
│  Tauri 客户端 │◄───────────────────►│   API 服务    │◄──────►│  Agent 客户端 │
│  (Win/Android)│  用户名密码登录      │  调度器       │  JSON  │  (只认令牌)   │
│             │   Bearer token      │  投递轮转器   │        │  /api/agent   │
│             │                     │  用户/权限    │        └──────────────┘
│  托盘 + 热键  │                     │  MCP 工具集   │◄───────┌──────────────┐
└──────────────┘                     └──────┬───────┘        │  开发看板     │
                                            │                │  (应用内视图) │
                     ┌────────────────────┐  │                └──────────────┘
                     │  PostgreSQL 18.6   │◄─┘  <PGHOST>:5432
                     │  <PGDATABASE>      │
                     │   └─ schema        │
                     │     desk_alarm     │  10 张表，public 不被碰
                     └────────────────────┘
```

**核心规则：服务端是计时的唯一权威。** 客户端不做权威计时，本地预判只让提示提前一点出现，最终以服务端写入的 `fired_at` 为准。

**投递是事务性 outbox。** 调度器只往 `deliveries` 表写 pending 记录，投递由独立的轮转器做，判定和送出去是两件不相干的事。`delivered` 的判定标准是「通道确认接收」，不是「我发出去了」。

## 提醒强度

设计上的第一条原则：**提醒疲劳是提醒类工具失效的首要原因。全都喊，等于全听不见。**

| | 强提示 | 弱提示 |
|---|---|---|
| 表现 | 全屏接管窗口，关不掉，会重复响 | 只出通知和顶部细横幅 |
| 动作 | 完成 / 打开链接 / 推迟 / 静音 | 完成 / 推迟 10 分钟 / **忽略（写理由）** |
| 升级 | 30 秒不处理就升级，5 分钟后每 2 分钟重复 | 永不升级 |
| 默认 | 只有文本含「一定要 / 必须 / 紧急…」才判强 | 其余全部默认弱，包括 agent 建的 |

`strength` 和 `bypassQuiet` 是**两个正交字段**。必须拆开，因为「服药」要 strong 且绕过静音，「站起来走走」要 weak 且不绕过。

**忽略和完成必须分开记**：

- `done` = 我做完了
- `dismissed` = 我看到了，故意不处理

分开的全部意义在于下面这个判断：

> 一条被忽略 2 次的条目自动降级为弱提示；被忽略 3 次提示「建议删除」。

## 临近梯度

列表里唯一的颜色梯度。安静是常态，只有快到了才逐级变暖：

| 档位 | 条件 | 表现 |
|---|---|---|
| 无 | > 24 小时 / 收集箱 / 已完成 | 无色 |
| soon | ≤ 24 小时 | 行首渗入 5% 强调色，暖灰点 |
| close | ≤ 1 小时 | 9%，暖棕点，时间变「还有 X 分钟」 |
| due | ≤ 15 分钟 | 14%，强调色点开始呼吸（2.6 秒一次，只动透明度） |
| over | 已逾期未处理 | 19%，强调色点，钟点后标「· X 还没处理」 |

用四级而不是连续渐变：连续变化在列表里会变成噪声，离散步进才一眼可读。梯度只从行首向左渗入（`linear-gradient(90deg, …)`），和 hover/选中用的背景色是两层，互不覆盖。

临近度随时间自己往前走，事件驱动的刷新不会推进它，所以客户端每 20 秒原地更新行（不改列表整体 innerHTML，滚动位置和选中态不丢），只变了梯度的行才动 DOM。

## 目录结构

```
app/                     桌面/Android 共用前端源码（不提供 Web 客户端）
  src/ui/main.ts          主视图 + 应用内开发看板（dashboard 视图）
  src/ui/takeover.ts      强提示接管窗口
  src/ui/capture.ts       快速记录小窗
mockups/                 设计手稿，仅留在仓库里，不部署
shared/types.ts          前后端共享契约
server/
  src/schema.pg.sql        10 张表结构
  src/db.ts                连接池、事务封装、连接诊断
  src/auth.ts              登录会话、Agent 令牌解析、requireHuman/requireAgent/requireAdmin
  src/bootstrap.ts         一次性创建管理员
  src/repo/                entries / devices / deliveries / settings / users / agent-tokens / stats
  src/scheduler.ts         调度器 + 投递轮转器
  src/hub.ts               按用户隔离的 WS 广播
  src/transport/           ws 与 fcm 两条投递通道
  src/mcp/                 工具集与 stdio 入口
  src/routes/              entries / devices / stream / mcp / admin / agent-tokens
  scripts/smoke.mjs        146 项冒烟测试
  scripts/verify.mjs       23 项端到端验证（打网关）
  scripts/isolation-check.mjs  跨用户隔离 / 设备随用户走 / 看板接口
  src/alarm.ts             升级阶梯 + 弱提示队列
  src/api.ts               HTTP/WS 通信层、Agent 令牌与用户管理
  src/styles.css           两套主题（桌面/Android 共用）
  src-tauri/src/commands.rs  原生命令（含 OS machine-id）
  src-tauri/src/windows.rs 窗口行为，接管窗口关不掉在这里
  src-tauri/src/update.rs  应用内升级（Gitee 优先 / GitHub 降级 + 签名校验）
docs/multi-user-design.md 多用户改造的设计与决策记录
docs/android.md          Android 端现状与接入步骤
docs/mcp.md              MCP 接入（Agent 令牌）
docs/mcp-rules.md        agent 该守的规矩
docker/                  nginx + api 镜像
docker-compose.local.yml 本地调试覆盖层（临时 Postgres），生产不用
```

## 起服务

```bash
# 生产（Woodpecker 也走这条）：宿主机 .env 里保留已有数据库地址，无需管理员密码（首次启动客户端初始化）
docker compose up -d --build

# 本地 Docker Desktop 调试：带 local 覆盖层才会起一个临时 Postgres，不动生产 .env
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up -d --build
docker compose ps
```

| 入口 | 地址 |
|---|---|
| API（客户端填这个） | http://<服务器地址>:8091/api/v1 |
| MCP（只认 Agent 令牌） | http://<服务器地址>:8091/api/mcp |
| Agent API | http://<服务器地址>:8091/api/agent |
| 健康检查 | http://<服务器地址>:8091/healthz |
| 开发看板 | 登录后左侧「开发看板」，仅管理员可见 |

只有一个 api 容器，客户端直连 8091，不再有 nginx 网关。容器内仍监听 8787，对外映射成 8091（沿用历史端口和防火墙规则）。

桌面客户端的页面源是 `http://tauri.localhost`，和服务端地址不同源，所以服务端必须回 CORS 头（`server/src/cors.ts`）。只放行客户端自己的源；自建 Web 前端要额外加，写进 `CORS_ORIGINS`（逗号分隔）后重建容器。

`<服务器地址>` 是本机在局域网或虚拟网络里的地址，同一网段的设备用这个地址访问。

**首次管理员初始化**：全新数据库里没有任何账号。第一次启动桌面客户端会出现「初始化管理员」页面，填用户名、密码、确认密码（≥8 位）即可；成功后直接用该账号登录。服务端不再从 env 读管理员密码，`users` 表非空后这个入口自动关闭。

后续用户由管理员在客户端「设置 → 用户管理」里创建（用户名 + 密码 + 角色），也能禁用、删除。

**设置页**：提醒参数、主题、关闭 X 的行为（退出 / 隐藏到托盘）、试响、PIN 与设备锁定、用户管理、本地日志策略都在左侧「设置」里（开机自启和锁定仅桌面端有）。PIN 存在服务端（scrypt 哈希），设了 PIN 才能锁设备；Windows 锁屏会自动锁定，系统解锁后自动解锁，手动锁定必须输 PIN。锁定设备按离线处理，到点提醒等解锁后补发。移动端不提供锁定，切后台不影响 FCM 提醒。

**两个看板**：普通用户有「我的看板」（连续守约天数、近 7 天准时率、每日柱状图，只统计自己）；管理员额外有「系统看板」（服务端与全局业务概览）。

桌面客户端第一次装完要自己填服务端地址（填 `host:port` 或完整 URL 都行）。

**改完 `.env` 必须 `up -d --force-recreate`**，restart 不会重新加载环境变量。

### 建表

`desk_alarm` schema 建好之后，服务端启动时会自动建表，幂等，可以反复跑。手动执行：

```bash
cd server && npm run db:init
```

`gen_random_uuid()` 从 PostgreSQL 13 起是内核函数，所以不需要 `pgcrypto` 扩展。共用库里装扩展经常没权限，索性不用。

## 跑客户端

开发模式：

```bash
cd app
npm install
npm run tauri:dev
```

### 构建产物

Windows 用 build-windows.ps1：

```powershell
# Windows：默认出 NSIS 安装包
.\scripts\build-windows.ps1
# 只出裸 exe，跳过安装包（自用测试够用，快很多）
.\scripts\build-windows.ps1 -NoInstaller
```

Android 在有 SDK 的机器上用 build-android.ps1（见 `docs/android.md`）：

```powershell
.\scripts\build-android.ps1                 # universal APK
.\scripts\build-android.ps1 -Target aarch64  # 只打 arm64
```

产物位置：

| 平台 | 路径 |
|---|---|
| Windows exe | `app/src-tauri/target/release/deskalarm.exe` |
| Windows 安装包 | `app/src-tauri/target/release/bundle/nsis/*.exe` |
| Android APK | `app/src-tauri/gen/android/app/build/outputs/apk/` |

### 平台产物与按钮区分

`app/` 只有一套源码，打包成桌面和 Android；**不提供 Web 客户端**——浏览器拿不到 OS 级 machine-id，而设备身份是整套推送/去重/令牌机制的基础，与其做个半功能的 Web，不如不做。网关根路径只返回一句「请安装桌面客户端」。

| 目标 | 命令 / 方式 | 界面差异 |
|---|---|---|
| Windows | `.\scripts\build-windows.ps1` | 全部按钮可见：试响、更新、快速记、缩到托盘、开机自启、推送设备 |
| Android | `.\scripts\build-android.ps1`（需 SDK） | 桌面专属按钮由 `#[cfg(desktop)]` 隔开、前端按 `platform()` 隐藏；通知可用；`machine_id()` 已加 Android 分支 |

按平台隐藏按钮的逻辑在 `app/src/ui/main.ts`，平台由原生命令 `platform()` 返回。

**不再部署静态原型**。`mockups/` 只留在仓库里当设计手稿，网关不再托管它——之前根路径直接能看到写死的演示数据（「逾期 2 小时」那些），既绕过登录又误导人。

### 应用内升级

顶栏「更新」按钮：检查 → 下载 → 签名校验 → 安装 → 重启，全部由 `app/src-tauri/src/update.rs` + 官方 updater 插件完成。Gitee 清单优先，静默落后时自动复核 GitHub；下载地址有域名白名单，`.sig` 用打包期公钥校验。启动时还会一天一次后台检查，发现新版只提示、不自动装。详见 `docs/update.md`。

### 发版：推一个 tag，两边一起走

服务端和客户端分在两个 CI 上，但**共享同一个 `v*` tag**，推一次就都走完：

| 内容 | 在哪跑 | 干什么 |
|---|---|---|
| 服务端 | Woodpecker（`.woodpecker.yaml`） | 构建 api 镜像推 registry，`docker compose` 拉起并等健康检查 |
| 客户端 | GitHub Actions（`.github/workflows/build.yml`） | 打包 Windows NSIS 安装包，建 GitHub Release 并挂上去 |
| Gitee 镜像 | GitHub Actions（`build.yml` 的 `gitee-release`） | 推 tag 到 Gitee，建同名 Release，把同样的安装包传上去 |

Android 不在这条流水线里——在有 SDK 的机器上用 `scripts/build-android.ps1` 本地构建。

```bash
# 版本号来源只有 tag 一处，三处声明文件由脚本同步
git tag v0.2.0
git push origin v0.2.0
```

推完 tag 之后 Windows 安装包会出现在仓库的 Releases 页面。

**客户端构建时用 tag 里的版本号覆盖** `tauri.conf.json` / `Cargo.toml` / `package.json`，仓库里的文件保持 0.1.0 不被改动；产物文件名和「应用和功能」里显示的版本跟 tag 一致。

本地要打出和 CI 一样的版本号：

```powershell
.\scripts\build-windows.ps1 -Version v0.2.0
```

GitHub Actions 的触发范围：

| 事件 | 行为 |
|---|---|
| 推 `v*` tag | Windows 打包，发 Release |
| 手动触发并填 tag | 同上，用于补包或重跑 |
| 手动触发不填 tag | 只打包，产物在 workflow artifact，不动 Release |
| PR | 只跑类型检查、构建、对比度、URL、需求对齐自检，不打包 |
| push main | 不触发 |

**手动填的 tag 必须已经推到远端**，否则会直接报错，而不是让 `gh` 从默认分支造一个 tag。

桌面专属能力（托盘、热键、开机自启、updater、多窗口）在 Rust 侧用 `#[cfg(desktop)]` 隔开，移动端只编译共用部分；平台由原生命令 `platform()` 返回，前端据此隐藏桌面专属按钮。`machine_id()` 按平台分支：Windows 读注册表、Linux 读 `/etc/machine-id`、Android 读系统属性。

**用户在客户端里改地址**：登录页最上面就是「服务端地址」输入框，带「测试连接」按钮；登录后点顶栏的连接状态也能打开切换面板。填 `host:port` 不用带协议，会自动补 `http://`。

登录页不预填地址，第一次装完要自己填。填完记住，下次开就直接连。

**多用户**：登录用用户名 + 密码。管理员在「服务端与本机设备」面板里管理用户（创建 / 禁用 / 改密 / 删用户）。不同用户之间的提醒、设备、设置完全隔离；同一台机器换人登录时，设备自动跟着新用户走，旧会话立即失效。

设备身份用 OS 级 machine-id（不可变），不再用浏览器随机指纹。不提供 Web 客户端。

改地址解析的逻辑后跑 `cd app && node scripts/url-check.mjs`。

### 配色

默认暗色（近黑底 + 橙），顶栏右侧一键切到**莫兰迪**（暖灰纸底 + 陶土红），更适合白天长时间开着。选择会记住，capture 小窗和接管窗口跟着一起变。

两套主题只在 `styles.css` 顶部换变量，规则区不允许写字面色值——写死的颜色不会跟着主题变。改色后必须跑：

```bash
cd app && node scripts/contrast.mjs
```

脚本会把两套色板都算一遍（正文 4.5:1、控件边界 3:1、实心按钮上的字），不达标直接非零退出。

### 关于 CSP

`tauri.conf.json` 里的 `app.security.csp` 是编译期写死的白名单，早期版本把服务端地址逐个列进去。问题是地址由用户在运行时填，静态白名单和服务端可配置天然冲突——用户填一个没列过的地址，会被 CSP 拦掉，表现为"连不上"，且完全看不出原因。

现在只放开 `connect-src`（`http: https: ws: wss:`），其余保持严格：

```
default-src 'self'; img-src 'self' asset: http://asset.localhost data:;
style-src 'self' 'unsafe-inline';
connect-src 'self' ipc: http://ipc.localhost http: https: ws: wss:
```

取舍：放开 `connect-src` 意味着页面可以往任意地址发请求。本应用只加载本地打包的代码，不加载远程脚本，所以实际风险有限；而换来的是用户填什么地址都能用。如果这个工具要分发给别人用，需要重新评估这个选择。

安装包构建要从 GitHub 下载 NSIS 工具链，网络不顺会超时。自用直接跑 exe 就够，或者用 `-NoInstaller`。

## 测试

```bash
cd server
npm run typecheck
npm run build
npm run smoke            # 146 项。会建临时库，跑完删掉
node scripts/verify.mjs  # 含管理员初始化、API、MCP/Agent 令牌
node scripts/e2e-check.mjs   # 联调自检，真跑一遍调度/确认/忽略/MCP
npm run repeat           # 14 项。重复日期与月末钳位
npm run isolation        # 14 项。跨用户隔离 / 设备随用户走 / 看板接口（需栈起着）
```

`e2e-check` 不建临时库，打的是真实部署，验证的是调度器到点触发、确认与忽略分开记、被忽略 2 次自动降级、MCP 防呆这几条核心链路。跑完自动清理测试数据。首次运行会先走 `/setup` 初始化管理员，用户名固定 `admin`，密码取 `ADMIN_PASSWORD` 环境变量（默认 `admin123456`）。

本地起好栈后还可以跑 `node scripts/isolation-check.mjs`，验证跨用户隔离、设备随用户走和看板接口。

冒烟测试需要连得上 `127.0.0.1:15432` 的 Postgres，且口令要等于 `SMOKE_PG_PASSWORD`。最省事的办法是用本地覆盖层把栈起起来（它自带这个端口的库）：

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up -d --build
cd server && SMOKE_PG_PASSWORD=deskalarm npm run smoke
```

`docker-compose.local.yml` 只在这条命令里生效；Woodpecker 的普通 `docker compose up -d` 不会碰它，仍然用宿主机 `.env` 里已有的数据库。

## 强提示的升级阶梯

```
0 秒      Windows Toast + 接管窗口亮起
30 秒     加抖动，窗口关不掉
5 分钟    每 2 分钟重复一次
```

停止条件只有两个：用户处理了，或者别的设备已经处理了（收到 `entry.acked` 广播就立刻停）。

接管窗口的「关不掉」在 `src-tauri/src/windows.rs` 里靠 `TAKEOVER_UNLOCKED` 原子标志实现，默认锁死，前端处理完才解锁。

静音时段（默认 23:30 到 07:00）内普通提醒只出通知不进接管窗口，标了 `bypassQuiet` 的照响。

## 多设备去重

任意设备点完成，服务端把 `deliveries` 改成 `acked` 并广播 `entry.acked`，其它正在响的设备立刻停铃并降级显示「已在 XX 完成」。

离线设备不丢提醒：投递记录留在 `pending`，设备重新上线时 `welcome` 消息里带 `missed` 列表并标注迟了多久。重试超时的会主动放弃，机会留给补发，不会让坏 token 无限重试。

## MCP 与 Agent 令牌

见 `docs/mcp.md`。三条防呆规则：写操作先 `plan_changes` 再 `apply_changes`、强提示必须给 `reason`、`idempotencyKey` 防重。

MCP 入口只认**每用户自助签发的 Agent 令牌**，登录 token 会被 403。所有用户都有独立的「Agent 令牌」模块：签发时选只读/读写，machine-id 可选（桌面可绑定本机，云端 agent 不绑），明文只显示一次、服务端只存哈希，随时可撤销。没有全局 `MCP_TOKEN`。

另有一套**独立的 Agent API**：`GET/POST/PATCH/DELETE /api/agent/entries`、`GET /api/agent/devices`、`GET /api/agent/whoami`。它和 `/api/v1` 用户接口分开，只认 Agent 令牌，并按令牌 scope 限制读写；所有操作都限定在签发用户自己的数据里。未来接入 agents 就走这套接口。

## 开发看板

看板是**应用内的一个视图**，不是独立页面：登录后左侧「开发看板」（仅管理员可见）。总览服务健康、调度器计数、条目状态、投递状态与失败、设备和用户数，每 5 秒刷新。数据来自 `GET /api/v1/admin/overview`。

桌面 / Android 用的是同一份前端源码，看板在两端都一样。

## 端口与防火墙

对外只有 **8091**（`.env` 的 `WEB_PORT`），映射到 api 容器的 8787。没有 nginx 网关了，客户端直接连 8091。

8080、8088、8090 容易和其它服务撞号，所以从 8091 起用。撞号的一种表现是服务看起来活着、健康检查也过，但请求被同端口上的另一个进程接走（例如返回 `{"detail":"Not Found"}`）；排查这类问题先换端口验证，比对着日志找更快。

要换端口只动 `.env` 的 `WEB_PORT`，然后 `up -d --force-recreate`。

ZeroTier 网卡被 Windows 归为「公用网络」，默认拦入站：

```powershell
# 需要管理员权限。仓库里有现成脚本：
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-firewall-8091.ps1
New-NetFirewallRule -DisplayName "DeskAlarm 8091" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8091 -Profile Any -RemoteAddress <你的虚拟网段，如 100.64.0.0/24>
```

## 还没做的

- Android 客户端。代码就绪、已按移动端 cfg 适配，在有 SDK 的机器上用 `scripts/build-android.ps1` 构建。步骤见 `docs/android.md`
- FCM 凭据。没配的话安卓到点不会响，只会留在队列里等上线补发。服务端启动日志会打一行 `FCM 不可用`
- Android 推送插件还没接，当前安卓到点靠「下次上线 welcome 补发」兜底
- 代码签名。现在跑 exe 有 SmartScreen 提示
- Windows 专注助手开启时会吞掉 Toast，所以应用内横幅是必须的，不能只依赖系统通知

## 许可

MIT，见 [LICENSE](LICENSE)。
