# DeskAlarm — Agent 工作规约

## 0. 项目定位
一句话：到点强提示的桌面提醒与调度系统（服务端 Fastify + PostgreSQL 18.6 统一裁决调度与 outbox 投递，客户端基于 Tauri 2 跨平台渲染接管窗口与托盘）。
- 仓库地址：`https://github.com/soldier-cv/desk-alarm.git`
- 默认主分支：`main`

## 1. 运行环境事实
- 生产服务端 hostPath：`/opt/code/desk-alarm`（宿主机部署目录，由 Woodpecker CI 自动同步，严禁手动直接写产物）
- 本地开发/代码仓路径：`/opt/code/desk-alarm-repo`（Git 唯一代码工作区）
- 生产服务访问入口：
  - 静态原型/网关入口：`http://100.64.0.88:8093/`（宿主机端口 8093 映射容器内 8091）
  - API 直连入口：`http://100.64.0.88:8787/api/v1`（Fastify 监听端口 8787）
  - 网关健康检查入口：`http://100.64.0.88:8093/healthz`
  - MCP HTTP 入口：`http://100.64.0.88:8093/api/mcp`
- 数据库真源：PostgreSQL 18.6（共用库 `general_db`，专有隔离 schema `desk_alarm`，靠连接 options `search_path=desk_alarm,public` 隔离，严禁污染 `public`）
- 凭据真源：生产配置 `.env` 位于 `/opt/code/desk-alarm/.env`（已加 `.gitignore`，严禁入库）；代码仓仅保留模板 `.env.example`，仅含键名与注释。

## 2. 硬规则（含验证方式）
1. **严禁向生产 hostPath (`/opt/code/desk-alarm`) 直接写代码或构建产物**：所有改动必须在 `/opt/code/desk-alarm-repo` 仓库内修改、提交并 push，由 Woodpecker CI 触发同步与部署。
   - 验证方式：`cd /opt/code/desk-alarm-repo && git status`；检查 `/opt/code/desk-alarm` 下无非 CI 写入的未跟踪文件。
2. **严禁污染共用库 `general_db` 的 `public` schema**：所有数据表定义、增删改查均必须限定在 `desk_alarm` schema 内。
   - 验证方式：`grep -rn "public\." server/src/` 输出必须为空。
3. **界面严禁堆砌需求描述或实现说明等开发自叙**（遵循 §0.2 界面文本纪律）：页面只放用户操作、状态与错误提示。
   - 验证方式：`grep -rnE "本功能实现|为了满足需求|为了实现|根据需求" mockups/ app/src/` 必须 0 命中。
4. **暗色主题色板对比度必须由脚本严格计算**：正文对比度 ≥ 4.5:1，控件边界 ≥ 3:1，禁止凭肉眼调色。
   - 验证方式：`cd app && node scripts/contrast.mjs` 必须全部 PASS 且 exit 0。
5. **CSP `connect-src` 严禁改回单 IP 白名单**：必须保持 `http: https: ws: wss:` 动态协议连接支持，以支持用户自定义服务端地址。
   - 验证方式：`grep "connect-src" app/src-tauri/tauri.conf.json` 必须包含 `http: https: ws: wss:`。
6. **客户端严禁引入 Windows 专属 Win32 API**：保持 Windows 与 macOS 跨平台编译一致性。
   - 验证方式：`grep -rnE "windows\.h|winapi" app/src-tauri/src/` 必须 0 命中。
7. **服务端是计时的唯一权威**：客户端不得自行裁决到点或篡改 `fired_at` 字段，客户端仅接收服务端推送事件。
   - 验证方式：`grep -rn "fired_at" app/src/` 不得出现写入或更新 `fired_at` 的业务逻辑。
8. **严禁提交凭据与私钥文件入库**：防范 `.env`、`*.key`、`*.pem`、`*.token` 泄露。
   - 验证方式：`git ls-files | grep -E '\.env$|\.pem$|\.key$|\.token$'` 必须输出为空。

## 3. 开发与验证流程
1. **开工拉齐**：每次开工必须先执行 `git fetch && git pull --ff-only origin main` 拉齐远端。
2. **全局需求与规范对齐验证**：
   ```bash
   node scripts/align-check.mjs
   ```
3. **主题与地址规范验证**：
   ```bash
   cd app && node scripts/contrast.mjs
   cd app && node scripts/url-check.mjs
   ```
4. **客户端类型与构建验证**：
   ```bash
   cd app && npx tsc --noEmit && npx vite build
   ```
5. **服务端测试验证**（本地起库或 CI 环境）：
   ```bash
   cd server && npm run smoke && npm run e2e
   cd server && npm run repeat
   ```

## 4. 已知坑
1. **生产环境配置重载**：修改 `.env` 后必须执行 `docker compose up -d --force-recreate`；执行 `docker compose restart` 不会重新加载环境变量。
2. **宿主机端口冲突防护**：本机 `8090`、`8088` 等端口被其他服务占用；生产网关通过宿主机 `8093` 端口映射容器内 `8091`。
3. **macOS 客户端构建依赖**：必须在真机 macOS 或 GitHub Actions macOS runner 上构建，跨平台交叉编译无法生成 `.app` 和 `.dmg` 签名包。
4. **`windows.rs` 文件名误区**：`app/src-tauri/src/windows.rs` 管理的是应用自身的主窗口、接管窗口和捕获窗口三个 Tauri 窗口行为，并非 Windows 系统专有逻辑。
5. **Woodpecker 部署同步特性**：流水线会以覆盖方式同步 `docker`、`server`、`shared`、`mockups` 至 `/opt/code/desk-alarm/`，但会保留宿主机已有的 `.env`，切勿手动覆盖生产 `.env`。
6. **容器重命名冲突**：历史版本容器名为 `deskalarm-web`，新版已重命名为 `deskalarm-gateway`；部署流水线显式清理旧容器以避免 8091 端口被占死。

## 5. 需求台账 / 决策日志
- 2026-10-10: 确定架构与双 CI 分工：Woodpecker 管服务端内网镜像与 compose 部署，GitHub Actions 管跨平台客户端构建与对外发布。
- 2026-10-12: CSP connect-src 开放为协议级白名单，支持用户在客户端动态配置服务端连接地址。
- 2026-10-14: 确定数据库共用库规范，使用 PostgreSQL 18.6 `search_path=desk_alarm,public`，不使用需 root 权限的扩展。
- 2026-10-18: 客户端发版触发收敛为 `v*` tag 触发，与服务端版本对齐；多端统一使用 tag 共享版本号。
- 2026-10-20: 客户端增加应用内自动更新机制，确定 Gitee Releases 国内优先、GitHub Releases 国外降级的双轨分发策略。
- 2026-10-22: 基础镜像安全升级，API 与 CI 统一提升至 Node `22.23.4`，网关提升至 Nginx `1.31.8-alpine`。
