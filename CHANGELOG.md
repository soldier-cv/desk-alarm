# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [Unreleased]

### Security
- 升级 Node 基础镜像与 GitHub Actions CI 环境至 `node:22.23.4`，废弃已 EOL 的 Node 20（修复 2026-10 安全批次漏洞）。
- 升级服务端 Nginx 反代网关基础镜像至 `nginx:1.31.8-alpine`。

### Fixed
- CI: 修复 `latest-json` job 缺失 checkout 导致 gh cli 无法推断当前仓库的问题，补齐 `contents: write` 权限。
- CI: 修复 macOS updater 签名打包路径取错目录问题，统一改为 `.app.tar.gz` 格式并同步 `latest.json`。
- CI: 客户端打包前增加私钥格式预检步骤，避免编译完成后在签名阶段因格式错误中断。
- CI: `gh release upload` 增加指数退避重试逻辑，抵御 GitHub API 偶发 5xx 故障。

## [v0.2.3] - 2026-10-20

### Added
- 客户端应用内自动更新机制：国内环境优先从 Gitee Releases 下载更新包，国外环境降级走 GitHub Releases。
- 客户端自动更新校验增强：更新模块增加下载域名与地址白名单校验，防止重定向劫持。
- CI: 增加 Gitee Release 附件同步任务（`gitee-release`），Windows 安装包与 macOS dmg 自动分发至 Gitee。

### Changed
- 配置与敏感元数据解耦：移除代码中的硬编码口令与内网 IP，统一改由环境变量配置。
- 服务端 Nginx 反代容器重命名为 `deskalarm-gateway`（服务名 `gateway`），避免与历史遗留容器冲突。
- 完善开源许可与项目文档：补齐 MIT License，产物名称统一定义为 `DeskAlarm`。

### Fixed
- 修复 `scripts/set-version.mjs` 重复设置同一版本号时误报失败的问题。
- CI: 优化 Gitee Release 文件上传为 multipart/form-data 格式，并增加在缺少 `GITEE_TOKEN` 时不阻断主发布流程。

## [v0.2.2] - 2026-10-18

### Fixed
- CI: Release 附件重命名为纯 ASCII 命名规范，解决中文导致的产物名称前缀丢失问题。

## [v0.2.1] - 2026-10-18

### Fixed
- CI: 构建打包时显式传入 `productName` 参数，修复客户端安装包文件名丢失前缀的问题。

## [v0.2.0] - 2026-10-18

### Added
- 客户端莫兰迪深色系主题与高可读性色板，保证所有 UI 控件交互可达。
- 客户端推迟提醒提供 5m / 15m / 1h / 明天 等多档可选项。

### Changed
- 统一发版规范：客户端打包由 push 触发调整为 `v*` tag 触发，与服务端 Woodpecker 流水线触发机制对齐。
- 客户端列表显示降噪，编辑模式下支持本地防丢字。
- 客户端设备指纹生成一次后本地落盘持久化，避免每次重启刷新设备记录。

### Fixed
- 修复服务端条目默认强度判定及视图边界条件，修复多处未捕获静默异常。
- 清理深色模式下失效的 CSS 规则与多余注释。

## [v0.1.0] - 2026-10-14

### Added
- 桌面强提醒核心架构初始化：Node.js Fastify 服务端调度与 PostgreSQL 18.6 事务性 outbox 投递机制。
- 强提示（全屏接管、无法关闭、循环督促）与弱提示（收集箱、横幅、静音）分级调度模型。
- MCP (Model Context Protocol) 协议支持，提供 stdio 与 HTTP 双入口。
- 基于 Tauri 2 构建的桌面客户端（支持 Windows / macOS 多窗口渲染：main / takeover / capture）。
- 服务端 Woodpecker CI 部署流水线，支持双 tag 推送内网镜像仓库与 Docker Compose 自动部署。
- Gitee 源码镜像单向同步流水线（`sync-gitee.yml`）。
- 服务端 125 项冒烟测试与连接诊断自愈提示脚本。
