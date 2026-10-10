# DeskAlarm

到点强提示的桌面工具。客户端与服务端分离，同一条提醒可指定推送到多台设备。

## 当前状态

| 模块 | 状态 |
|---|---|
| 服务端（Node + Fastify + PostgreSQL） | 完成，**125 项冒烟测试 + 21 项端到端验证全通过** |
| 强弱提示与忽略记录 | 完成 |
| MCP（stdio + HTTP 双入口） | 完成 |
| Windows 客户端（Tauri 2） | 完成，`app/src-tauri/target/release/deskalarm.exe`（3.6 MB） |
| macOS 客户端 | 代码就绪、跨平台无阻碍，**必须在 Mac 或 CI 上构建**，见 `docs/macos-build.md` |
| Android 客户端 | **卡在工具链**，代码侧已就绪，见 `docs/android.md` |

## 数据库授权

**已经就绪，不用再做什么。** 88 的 `general_db` 里 `desk_alarm` schema 已存在、owner 是 `desk_alarm`，CREATE / USAGE 权限都有，实测能建表删表。服务端启动时自动建那 8 张表。

`general_db` 是共用库（还有 `image_gallery` / `image_gallery_dev` / `porter`），所以全部表隔离在 `desk_alarm` 这一层，靠 `search_path` 生效，`public` 保持零表。换机器或重建库时才需要下面这条，用 `general_db` 的 owner 执行：

```sql
CREATE SCHEMA desk_alarm AUTHORIZATION desk_alarm;
```

只建 schema，不动 `public`，别的项目一点影响没有。

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
                    │  PostgreSQL 18.6   │  100.64.0.88:5432
                    │  general_db        │
                    │   └─ schema        │
                    │     desk_alarm     │  8 张表，public 不被碰
                    └────────────────────┘
```

**核心规则：服务端是计时的唯一权威。** 客户端不做权威计时，本地预判只让提示提前一点出现，最终以服务端写入的 `fired_at` 为准。

**投递是事务性 outbox。** 调度器只往 `deliveries` 表写 pending 记录，投递由独立的轮转器做，判定和送出去是两件不相干的事。`delivered` 的判定标准是「通道确认接收」，不是「我发出去了」。

## 提醒强度

这是整个设计里最重要的一条：**提醒疲劳是提醒类工具死掉的头号原因。全都在喊，结果是全都听不见。**

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

这是 App 在告诉你一件关于你自己行为、而你本来看不见的事。

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
| 静态原型 | http://100.64.0.120:8091/ |
| API（经网关） | http://100.64.0.120:8091/api/v1 |
| API（直连） | http://127.0.0.1:8787/api/v1 |
| MCP | http://127.0.0.1:8091/api/mcp |
| 健康检查 | http://100.64.0.120:8091/healthz |

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
| macOS app | `app/src-tauri/target/release/bundle/macos/提醒器.app` |
| macOS dmg | `app/src-tauri/target/release/bundle/dmg/*.dmg` |

**macOS 必须在真 Mac 上构建**，跨平台编译不了：`.app` 和 `.dmg` 要 Xcode 的 macOS SDK 和 codesign，这些只有 macOS 有。没有 Mac 就得用 CI 的 `macos` runner，见 `docs/macos-build.md`。

Rust 侧没有平台专属代码，窗口、托盘、热键、通知全是 Tauri 跨平台 API，所以 macOS 不需要改逻辑，只是换个机器构建而已。图标 `icon.icns` 已经在了。

macOS 没做代码签名和公证，首次打开被 Gatekeeper 拦的话：

```bash
xattr -cr /Applications/提醒器.app
```

**改服务端地址有两处，缺一不可**：

1. `app/src/api.ts` 的 `DEFAULT_CONFIG.baseUrl`
2. `app/src-tauri/tauri.conf.json` 的 `app.security.csp`。CSP 是白名单，不在里面会被拦掉

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
  -e POSTGRES_USER=desk_alarm -e POSTGRES_PASSWORD=TpTohsACO3LBBU \
  -e POSTGRES_DB=general_db -p 15432:5432 postgres:18-alpine
```

注意两件事：容器里访问宿主机要用 `host.docker.internal`（`127.0.0.1` 指容器自己），以及 `PGSCHEMA` 要和 `.env` 里的值一致。

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

端口号是撞出来的，本机已经占了一串：8080、8088 早被别的服务占了，8090 上还跑着一个 Python/FastAPI，**它会抢走 `127.0.0.1:8090` 的回环流量** —— 我们的容器照常监听 8090、健康检查也过，但同一个地址上的 HTTP 请求全被它接走，返回 `{"detail":"Not Found"}`。这种故障特征是"服务看起来活着但响应格式不对"，比连不上更难查。所以走 8091。

要换端口只动 `.env` 的 `WEB_PORT`，然后 `up -d --force-recreate`。

ZeroTier 网卡被 Windows 归为「公用网络」，默认拦入站：

```powershell
# 需要管理员权限。仓库里有现成脚本：
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-firewall-8091.ps1
New-NetFirewallRule -DisplayName "DeskAlarm 8091" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8091 -Profile Any -RemoteAddress 100.64.0.0/24
```

## 还没做的

- Android 客户端。代码侧就绪，缺 NDK / build-tools / adb，出不了包。步骤见 `docs/android.md`
- FCM 凭据。没配的话安卓到点不会响，只会留在队列里等上线补发。服务端启动日志会打一行 `FCM 不可用`
- 代码签名。现在跑 exe 有 SmartScreen 提示
- Windows 专注助手开启时会吞掉 Toast，所以应用内横幅是必须的，不能只依赖系统通知
