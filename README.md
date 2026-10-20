# DeskAlarm

到点强提示的桌面工具。客户端与服务端分离，同一条提醒可指定推送到多台设备。

## 当前状态

| 模块 | 状态 |
|---|---|
| 服务端（Node + Fastify + PostgreSQL） | 完成，**125 项冒烟测试 + 21 项端到端验证全通过** |
| 强弱提示与忽略记录 | 完成 |
| MCP（stdio + HTTP 双入口） | 完成 |
| Windows 客户端（Tauri 2） | 完成，`app/src-tauri/target/release/deskalarm.exe`（3.6 MB） |
| macOS 客户端 | 代码就绪，无平台专属逻辑，须在 Mac 或 CI 上构建，见 `docs/macos-build.md` |
| Android 客户端 | 代码就绪，构建工具链未接通，暂不出包，见 `docs/android.md` |

## 数据库授权

`general_db` 里 `desk_alarm` schema 已就绪，owner 是 `desk_alarm`，CREATE / USAGE 权限齐全。服务端启动时自动建那 8 张表。

`general_db` 是共用库，同库里还有其它项目的 schema，所以全部表隔离在 `desk_alarm` 这一层，靠 `search_path` 生效，`public` 保持零表。换机器或重建库时需要下面这条，用 `general_db` 的 owner 执行：

```sql
CREATE SCHEMA desk_alarm AUTHORIZATION desk_alarm;
```

只建 schema，不动 `public`，不影响同库其它项目。

## 架构

```
┌──────────────┐        HTTP + WebSocket        ┌──────────────┐
│  Tauri 客户端 │◄──────────────────────────────►│   API 服务   │
│  (Windows)   │                                │              │
│              │   触发事件由服务端裁决          │  调度器      │
│  3 个窗口     │◄───────────────────────────────│  投递轮转器  │
│  托盘 + 热键  │                                │  MCP 工具集  │
└──────────────┘                                └──────────────┘
                    ┌────────────────────┐
                    │  PostgreSQL 18.6   │  <PGHOST>:5432
                    │  general_db        │
                    │   └─ schema        │
                    │     desk_alarm     │  8 张表，public 不被碰
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
| 默认 | 给了时间就是强提示 | 进收集箱的、agent 建的，默认弱 |

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
mockups/prototype.html   交互原型（静态）
shared/types.ts          前后端共享契约
server/
  src/schema.pg.sql        库结构
  src/db.ts                连接池、事务封装、连接诊断
  src/repo/                entries / devices / deliveries / settings
  src/scheduler.ts         调度器 + 投递轮转器
  src/transport/           ws 与 fcm 两条投递通道
  src/mcp/                 工具集与 stdio 入口
  scripts/smoke.mjs        125 项冒烟测试
  scripts/verify.mjs       端到端验证（打网关）
app/                     Tauri 2 客户端
  src/alarm.ts             升级阶梯 + 弱提示队列
  src/api.ts               HTTP/WS 通信层
  src/ui/                  main / takeover / capture 三个窗口
  src-tauri/src/windows.rs 窗口行为，接管窗口关不掉在这里
docs/android.md          Android 端现状与接入步骤
docs/mcp.md              MCP 接入
docs/mcp-rules.md        agent 该守的规矩
docker/                  nginx + api 镜像
```

## 起服务

```bash
# .env 里改好 PGHOST / PGDATABASE / PGUSER / PGPASSWORD / DESKALARM_PASSCODE
docker compose up -d --build
docker compose ps
```

| 入口 | 地址 |
|---|---|
| 静态原型 | http://<服务器地址>:8091/ |
| API（经网关） | http://<服务器地址>:8091/api/v1 |
| API（直连） | http://127.0.0.1:8787/api/v1 |
| MCP | http://127.0.0.1:8091/api/mcp |
| 健康检查 | http://<服务器地址>:8091/healthz |

`<服务器地址>` 是本机在局域网或虚拟网络里的地址，同一网段的设备用这个地址访问。

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

跨平台，两条命令：

```powershell
# Windows：默认出 NSIS 安装包
.\scripts\build-windows.ps1
# 只出裸 exe，跳过安装包（自用测试够用，快很多）
.\scripts\build-windows.ps1 -NoInstaller
```

```bash
# macOS：必须在 Mac 上跑，Tauri 的 .app/.dmg 需要 Xcode 的 macOS SDK
./scripts/build-macos.sh              # 当前架构
./scripts/build-macos.sh universal    # Intel + Apple Silicon 通吃
./scripts/build-macos.sh aarch64      # 只 Apple Silicon
```

产物位置：

| 平台 | 路径 |
|---|---|
| Windows exe | `app/src-tauri/target/release/deskalarm.exe` |
| Windows 安装包 | `app/src-tauri/target/release/bundle/nsis/*.exe` |
| macOS app | `app/src-tauri/target/release/bundle/macos/DeskAlarm.app` |
| macOS dmg | `app/src-tauri/target/release/bundle/dmg/*.dmg` |

**macOS 必须在真 Mac 上构建**，跨平台编译不了：`.app` 和 `.dmg` 要 Xcode 的 macOS SDK 和 codesign，这些只有 macOS 有。没有 Mac 就得用 CI 的 `macos` runner，见 `docs/macos-build.md`。

### 发版：推一个 tag，两边一起走

服务端和客户端分在两个 CI 上，但**共享同一个 `v*` tag**，推一次就都走完：

| 内容 | 在哪跑 | 干什么 |
|---|---|---|
| 服务端 | Woodpecker（`.woodpecker.yaml`） | 构建 api/gateway 镜像推 registry，`docker compose` 拉起并等健康检查 |
| 客户端 | GitHub Actions（`.github/workflows/build.yml`） | 打包 Windows NSIS + macOS dmg，建 GitHub Release 并把安装包挂上去 |
| Gitee 镜像 | GitHub Actions（`build.yml` 的 `gitee-release`，排在两个打包 job 之后） | 推 tag 到 Gitee，建同名 Release，把同样的三个安装包传上去 |

```bash
# 版本号来源只有 tag 一处，三处声明文件由脚本同步
git tag v0.2.0
git push origin v0.2.0
```

推完 tag 之后 Windows 安装包和 macOS dmg 会出现在仓库的 Releases 页面。

**客户端构建时用 tag 里的版本号覆盖** `tauri.conf.json` / `Cargo.toml` / `package.json`，仓库里的文件保持 0.1.0 不被改动；产物文件名和「应用和功能」里显示的版本跟 tag 一致。

本地要打出和 CI 一样的版本号：

```powershell
.\scripts\build-windows.ps1 -Version v0.2.0
```

```bash
TAURI_VERSION=v0.2.0 ./scripts/build-macos.sh
```

GitHub Actions 的触发范围：

| 事件 | 行为 |
|---|---|
| 推 `v*` tag | Windows + macOS 打包，发 Release |
| 手动触发并填 tag | 同上，用于补包或重跑 |
| 手动触发不填 tag | 只打包，产物在 workflow artifact，不动 Release |
| PR | 只跑类型检查、构建、对比度、URL、需求对齐自检，不打包 |
| push main | 不触发 |

**手动填的 tag 必须已经推到远端**，否则会直接报错，而不是让 `gh` 从默认分支造一个 tag。

Rust 侧没有平台专属代码，窗口、托盘、热键、通知全是 Tauri 跨平台 API，所以 macOS 不需要改逻辑，只是换个机器构建而已。图标 `icon.icns` 已经在了。

macOS 没做代码签名和公证，首次打开被 Gatekeeper 拦的话：

```bash
xattr -cr /Applications/DeskAlarm.app
```

**用户在客户端里改地址**：登录页最上面就是「服务端地址」输入框，带「测试连接」按钮；登录后点顶栏的连接状态也能打开切换面板。填 `host:port` 不用带协议，会自动补 `http://`。

登录页不预填地址，第一次装完要自己填。填完记住，下次开就直接连。

多台设备填同一个地址就共享同一份提醒。换地址会清掉本地会话重新登录，因为旧 token 对新地址无效。

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
npm run smoke            # 125 项。会建临时库，跑完删掉
node scripts/verify.mjs  # 21 项。打网关，含静态页和 MCP
node scripts/e2e-check.mjs   # 26 项。联调自检，真跑一遍调度/确认/忽略/MCP
```

`e2e-check` 不建临时库，打的是真实部署（88 的 `general_db`），验证的是调度器到点触发、确认与忽略分开记、被忽略 2 次自动降级、MCP 防呆这几条核心链路。跑完自动清理测试数据。默认口令从 `DESKALARM_PASSCODE` 读。

冒烟测试需要连得上 Postgres。本地开发可以起一个：

```bash
docker run -d --name deskalarm-pg-dev \
  -e POSTGRES_USER=desk_alarm -e POSTGRES_PASSWORD=<本地口令，自己定> \
  -e POSTGRES_DB=general_db -p 15432:5432 postgres:18-alpine
```

注意三件事：容器里访问宿主机要用 `host.docker.internal`（`127.0.0.1` 指容器自己）、`PGPASSWORD` 填上面自定的那个口令、`PGSCHEMA` 要和 `.env` 里的值一致。

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

## MCP

见 `docs/mcp.md`。三条防呆规则：写操作先 `plan_changes` 再 `apply_changes`、强提示必须给 `reason`、`idempotencyKey` 防重。

## 端口与防火墙

网关用 **8091**（`.env` 的 `WEB_PORT`），API 直连用 **8787**。

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

- Android 客户端。代码侧就绪，构建工具链未接通，暂不出包。步骤见 `docs/android.md`
- FCM 凭据。没配的话安卓到点不会响，只会留在队列里等上线补发。服务端启动日志会打一行 `FCM 不可用`
- 代码签名。现在跑 exe 有 SmartScreen 提示
- Windows 专注助手开启时会吞掉 Toast，所以应用内横幅是必须的，不能只依赖系统通知

## 许可

MIT，见 [LICENSE](LICENSE)。
