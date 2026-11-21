# 多用户改造设计（含决策记录）

> 本文件是设计锁定记录。改动前先读，改行为时同步更新这里和 `requirements.md`。

## 理解确认

- 把单用户共享静态口令，改成**多用户用户名/密码 + 角色权限**，用户之间数据**完全隔离**
- 初始化提供**一次性创建管理员**入口（env + 启动引导），之后由管理员管理用户
- 当前无数据，**允许重新设计 schema**，不背迁移包袱
- 设备身份用 **OS 级 machine-id**（不可变），不用 localStorage 随机串
- **设备随用户走**：同机切换登录时，设备记录归属切到新用户；旧用户在该设备的会话失效
- **不提供 Web 客户端**：浏览器拿不到 OS machine-id；网关只做 API 反代
- Agent 令牌的 machine-id 可选：桌面可绑定本机，云端 agent 不绑；所有用户都有独立的令牌模块
- Agent 令牌由**每个用户自助签发**，绑定其 machine-id 与账号；MCP 入口只认 agent 令牌，登录 token 一律 403
- 减少 env：固定值写死在 compose，只有连接信息和初始管理员口令留在 env；提醒设置由用户在客户端改
- 保留 WS 实时总线、保留内网明文 HTTP + 公网 HTTPS 反代的部署方式
- 修复逾期时长锚点错误；补开发看板；顺手清理死代码

## 关键假设

- 规模：几十用户以内，单 PostgreSQL 实例，单部署
- 管理员是唯一能创建/禁用/删除用户的人
- 会话仍是服务端签发的随机 Bearer token，空闲 30 天 + 滑动续期 + 90 天绝对上限；WS token 仍走 query（HTTPS 反代下可接受）
- PIN 只在桌面端：设备本机 6 位数字，哈希只存本机，不入库、不传服务端；同一账号下的多台电脑各设各的，移动端不设置 PIN
- Android 出包 / 后台保活 / 代码签名仍暂缓

## 决策记录

| 决策 | 备选 | 选择理由 |
|---|---|---|
| 用户数据隔离 | 共享数据仅区分身份 | 用户明确要求完全隔离；schema 无数据可直接重设计 |
| 设备身份 | localStorage 随机指纹 / 硬件序列号 | OS machine-id 不可变、跨浏览器稳定；序列号过于敏感且不可移植 |
| 设备归属 | 设备固定绑首个用户 | 用户要求「设备随用户走」，换人登录时改归属并踢旧会话 |
| 鉴权实现 | better-auth / @fastify/passport / 自建 scrypt 模块 | 选**自建轻量模块**：现有模型是 DB 里的 Bearer token，第三方框架带 cookie/ORM/session 表，和 Tauri 客户端模型不匹配；密码哈希用 Node 内置 `scrypt`（随机盐 + 定长比较），不自己发明算法。`@node-rs/argon2` 作为可选升级路径记录在此 |
| Web 设备 | HttpOnly Cookie 指纹 / 不提供 Web | 浏览器拿不到 OS machine-id，直接不做 Web 客户端，最简单 |
| WS | 改纯 HTTP 轮询 | 用户接受保留 WS；轮询要补事件游标/心跳/silence，延迟退化到分钟级 |
| 管理员创建 | env 初始密码 / 客户端 setup 页 | 完全由管理员初始化：用户名 + 密码 + 确认密码，env 里不再有管理员账号密码；事务锁防止并发建两个管理员 |
| 配置来源 | 全放 env / 全放管理员 UI | 固定值（调度频率、池大小、日志级别）写死在 compose；连接信息和初始口令留 env；用户可调整的提醒设置留在客户端设置页。避免 env 膨胀 |
| Agent 令牌 | 全局 MCP_TOKEN env / 借用登录身份 | 每用户自助签发、独立表存哈希、machine-id 可选、带 read/write scope、可撤销；MCP 与 `/api/agent` 都用独立鉴权，登录 token 一律 403 |
| 逾期时长 | 保持 firedAt 锚点 | 改 `remindAt` 锚点；firedAt 是「调度器补火时刻」，重启后会把 3 天前任务显示成 2 小时 |
| PIN 归属 | 账号级服务端哈希（v0.3.0 D2） | 设备本机、只存哈希：同一账号下电脑/手机/多台电脑各设各的，改 PIN 不依赖账号密码；服务端不碰 PIN，避免把 PIN 发上网 |

## 数据模型

```
users          id, username(唯一), password_hash, role(admin|user), disabled, created_at
devices        id, machine_id(唯一), user_id, name, platform, transport, push_token,
               push_enabled, online, last_seen_at, created_at
sessions       token, user_id, device_id(可空), kind(user|mcp|dashboard), created_at, expires_at
entries        ... + user_id
entry_devices  ... (只允许指向同用户的设备，服务端校验)
deliveries     ... + user_id (冗余，便于按用户统计与补发过滤)
dismissals     ... + user_id
idempotency    key 改为 (user_id, key) 复合主键
settings       (user_id, key) 复合主键，每用户一份，新用户首次登录写默认值
```

### 关键不变量

1. `fired_at` 仍只由调度器写，仍是唯一计时权威
2. 所有列表/查询/写操作都必须带 `user_id` 过滤；`entry_devices` 目标必须属于同用户
3. `machine_id` 唯一；登录时若已存在且归属其它用户，则改归属 + 删除该设备的其它用户会话
4. 云端 agent 的令牌不传 `machineId`，不关联设备；桌面签发时可绑定本机
5. Agent 令牌只存 SHA-256 哈希，明文只在签发时返回一次；绑定签发用户的 machine-id，可设 read/write scope，可随时撤销

## API 变更

- `POST /api/v1/auth/login`：body 改为 `{ username, password, deviceName, platform, machineId?, transport?, pushToken? }`
  - 有 `machineId` → upsert device（归属切换、踢旧会话）
  - 无 `machineId` → 不建设备，device 返回 null
  - 返回 `{ token, user, device }`
- 新增管理员接口（仅 admin）：
  - `GET /api/v1/admin/users`、`POST /api/v1/admin/users`、`PATCH /api/v1/admin/users/:id`、`DELETE /api/v1/admin/users/:id`
  - `GET /api/v1/admin/overview`（开发看板数据）
- `GET /api/v1/devices` 等只返回当前用户的设备
- `GET /api/v1/settings` 返回当前用户的设置

## 机器指纹（Tauri）

- Rust command `machine_id()`：
  - Windows：读注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`（用 `winreg` crate，不调 Win32）
  - Linux：读 `/etc/machine-id`
  - Android：读 `ro.serialno` 等系统属性（见 `docs/android.md`）
  - 全部用 `#[cfg(target_os)]` 条件编译，保证三平台都能编译
- 前端 login / setup 时通过 `invoke('machine_id')` 获取；平台由 `platform()` 原生命令返回，界面按桌面/Android 区分按钮

## 错误处理与边界

- 密码错误 / 用户禁用 → 401，统一 `BAD_CREDENTIALS`，不区分用户名是否存在
- 登录限流：按 username + IP，15 分钟内最多 8 次失败
- `machineId` 被另一用户抢走：旧用户的该设备会话立即删除，旧设备上的 WS 会在下次操作时 401
- Agent 令牌被撤销 / 用户被禁用：MCP 调用返回 401，用户需重新签发
- 管理员不能删除自己；最后一个管理员不能禁用

## 测试策略

- 服务端：改写 `smoke.mjs` 覆盖注册管理员、多用户登录、跨用户不可见、设备归属切换、MCP 绑定
- 客户端：`tsc --noEmit` + `vite build`
- 逾期 bug：新增 `timeLabel` 单测（mock serverNow，构造 remindAt 远早于 firedAt 的 missed 条目）
- 端到端：`docker compose up -d --build` 后用 curl 验证管理接口、应用内看板的数据接口、WS 连通
