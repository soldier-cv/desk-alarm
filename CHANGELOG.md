# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [v0.4.1] - 2026-11-21

### Fixed
- Android 构建：compileSdk/targetSdk 与 CI 安装的 platform 从 37 降到 36（sdkmanager 当前最高只提供 36），修复 android job 在 `Install Android SDK components` 阶段失败。

## [v0.4.0] - 2026-11-20

### Added
- Android 发版接入 GitHub Actions：推 `v*` tag 时构建 universal APK、用发布密钥签名并校验指纹，挂到 GitHub Release 后同步到 Gitee Release 并校验下载地址。所需 Secrets 见 `docs/android.md`。

## [v0.3.7] - 2026-11-20

### Fixed
- WebSocket 心跳现在会刷新 `last_seen_at`，修复设备明明连着却被 `sweepOffline` 误判为离线。
- 同一设备还有其它连接时，断开一条不再立刻标离线。
- 侧栏「本机」状态改为读取服务端真实在线/锁定状态，不再固定显示绿点。

## [v0.3.6] - 2026-11-20

### Changed
- 自动检查更新去掉「一天一次」限制：用户开启后每次启动都检查，运行中每 30 分钟一次。
- 右上角「有更新 vX」按钮现在就是安装入口，点击直接下载安装并重启，无需再去设置页点第二次；设置页的检查/安装入口仍保留。
- 密码显隐改成眼睛图标（睁眼/闭眼两态），不再显示「显/隐」文字。

### Fixed
- 安装完成后清理下载的安装包，下次启动再扫一次残留文件。

## [v0.3.5] - 2026-11-20

### Added
- 服务端统一计数接口 `/entries/counts`，侧栏数字不再来自当前视图的局部数据。
- 已完成条目改为只读，提供「复制为新条目」快速复用，以及「重新提醒」。

### Fixed
- 切换视图时侧栏数字不再闪成 0；并发刷新加代次校验，旧响应不会再盖到新视图上。
- 编辑框聚焦时不会被后台刷新重绘，光标和未提交内容不再丢。
- 取消完成状态改走 rearm，不再被 DONE_READONLY 拦截；rearm 会真正清掉 done_at。
- 静音设置真正生效；忽略降级/提示删除次数改为读取用户配置，不再写死 2/3。
- 只对当前设备显示试响；登录平台按真实系统上报（macOS 用 mac）。
- 日期选择器切换日期/月份不再丢失已选时间，点日期也不会误判成外部点击而关闭。
- 条目创建/修改校验 kind、repeat、strength、bypassQuiet、devices，非法枚举不再入库。
- 设置页数据不再重复加载。

## [v0.3.4] - 2026-11-20

### Added
- 自动检查更新改为用户主动开启（默认关闭）：开启后启动时与每小时各检查一次，24 小时内不重复请求。
- 设置页显示上次检查结果；发现新版本时顶栏「更新」按钮高亮并显示版本号。

### Changed
- 检查与安装彻底分开：检查只提示，下载安装必须再点一次「安装 vX」按钮，绝不自动安装或自动重启。

## [v0.3.3] - 2026-11-20

### Added
- 自绘日期时间选择器：点一下弹月历 + 今天/明天/下周一/1 小时后快捷项，两套主题统一样式，替代各平台原生控件。
- 粘贴框的时间识别支持明确日期（`2026-10-12 10:12`、`2025年10月23日`），识别结果仍只作预览。
- 设置页新增「自动检查更新」开关，默认开；设备列表每台设备可单独试响。

### Fixed
- PIN 改为 6 位；设置、修改、移除 PIN 一律要验账号密码，修掉「填错密码也能成功」。
- PIN 与用户密码输入框支持小眼睛切换显示，不再是明文。
- 新建用户只能是普通用户，去掉多余角色下拉；密码必须二次确认；修掉删除用户无效、启用按钮状态反了的问题。
- 所有下拉统一自绘箭头并跟随主题配色，暗色主题不再弹出白色原生列表。
- 编辑条目改动控件后不再跳回顶部，滚动位置保持不变。
- 推迟选项改为「10 分钟后」并直接显示到点时刻，避免理解成「往前挪 10 分钟」。
- 更新安装只装清单里的最新版本，不装插件可能返回的旧缓存包。

## [v0.3.2] - 2026-11-20

### Fixed
- 修复更新检查：Gitee 的 `/releases/latest/download/latest.json` 实测 404，改为从 Gitee API 取最新 Release 的 `latest.json` 地址；安装时使用该地址而非按来源字符串猜测，避免实际走 GitHub 降级。

## [v0.3.1] - 2026-11-20

### Fixed
- 移除移动端锁定：Android/iOS 切后台或锁屏不再被锁定，FCM 提醒照常送达；设置页不再显示 PIN/锁定，服务端拒绝移动端锁定请求。

### Changed
- main 分支合入此前漏推的 Android 工程骨架提交。

## [v0.3.0] - 2026-11-20

### Added
- 设置页：提醒参数、主题、开机自启、关闭 X 行为、试响、用户管理、本地日志策略集中配置。
- 设备锁定（仅桌面端）：设置 PIN 后可手动锁定；Windows 锁屏自动锁定/解锁。锁定设备按离线处理，解锁后补发提醒。
- 我的看板：连续守约天数、近 7 天准时率、今日状态与每日柱状图，只统计本人数据。
- 设备列表显示上次登录 IP 与锁定状态。
- 本地日志：按级别写文件，按天分文件，可配保留天数。

### Changed
- 系统看板重新设计排版与数字层级；开发看板更名为系统看板。
- 主题按钮显示当前主题而不是下一个主题。
- 顶栏移除「缩到托盘」与「试响」按钮，统一收进设置页；点 X 默认退出程序，可在设置页改回隐藏到托盘。

### Security
- 服务端补 CORS 白名单，放行桌面客户端源；只回显指定 Origin，预检请求返回 204。
- PIN 在服务端以 scrypt 哈希保存，解锁与修改都要校验。

### Fixed
- 服务端默认端口从容器内 8787 改为对外 8091（MCP、e2e、输入框占位符同步）。
- 客户端设置项原本只在 WS welcome 里下发，现在设置页会主动读取服务端配置。
- 升级 Node 基础镜像与 GitHub Actions CI 环境至 `node:22.23.4`，废弃已 EOL 的 Node 20（修复 2026-10 安全批次漏洞）。
- 升级服务端 Nginx 反代网关基础镜像至 `nginx:1.31.8-alpine`。
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
