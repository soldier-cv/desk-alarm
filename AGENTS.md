# AGENTS.md

给 AI agent 和在这个仓库里改代码的人看。规矩放这里，改代码前先读。

## 注释：写「为什么」，不写「是什么」

代码里不要堆描述性文字。**能靠读代码看懂的，一律不写注释。**

具体分三类：

**不写**（代码本身已经说了）
```ts
// 遍历所有条目
for (const e of entries) { ... }

// 返回时间标签
function dayLabel(ts: number) { ... }
```

**要写**（代码看不出来的「为什么」，一两句，不超过两行）
```ts
// pg 的 Client 不显式 connect 直接 query，promise 不会 settle
```

**不写，要挪到文档**（设计理由、背景、历史、权衡取舍）
```ts
// ❌ 全都喊等于全都听不见
// ❌ 共用的库里往 public 塞表会和别的项目撞名
// ❌ 提醒疲劳是提醒类工具死掉的头号原因
```

第三类属于设计决策和需求背景，写在：

| 内容 | 去处 |
|---|---|
| 设计决策与理由 | `README.md` 对应章节、`docs/design.md` |
| 产品需求与规则 | `docs/requirements.md` |
| 运维与部署 | `README.md`、`.env.example` 注释 |
| 踩过的坑 | 代码里一行注释，或 `docs/` |

判据：**这句话删掉后，读代码的人会不会理解错或做错事？** 会，才留注释。不会，删掉。

代码里单条注释超过 2 行，基本都该挪走。

## 暗色主题：颜色必须算，不许挑

深色界面里「深字配深底」「框线融进背景」是这个项目最容易翻车的地方，眼睛看不出来。

- 正文对比度 ≥ 4.5:1
- UI 控件边界（输入框、勾选框、按钮）≥ 3:1

改 `app/src/styles.css` 的色板后跑：

```bash
cd app && node scripts/contrast.mjs
```

不达标会 exit 1。别靠目测判断。

**禁用**：在深色背景上用接近背景色的边框或文字。输入框、复选框这类边界一律用 `--line-input` / `--line-ctrl`，不要用 `--line`（那只是分隔线）。

## 验证：改了就说改了，不说「应该没问题」

- 服务端改动 → `cd server && npm run smoke && npm run e2e`
- 客户端改动 → `cd app && npx tsc --noEmit && npx vite build`
- 颜色改动 → `node scripts/contrast.mjs`
- 服务端地址解析改动 → `cd app && node scripts/url-check.mjs`
- 需求规则改动 → `node scripts/align-check.mjs`
- 端到端 → `node server/scripts/verify.mjs`（需要栈起着）

`smoke` 会建临时库跑完删掉。`e2e` 打真实部署，跑完自动清理。

## 跨平台：不要引入 Windows 专属代码

客户端要同时出 Windows 和 macOS 产物。`app/src-tauri/src/` 下只用 Tauri 跨平台 API。

注意 `windows.rs` 这个文件名有误导性——它管的是「应用自己的三个窗口」，不是 Windows 系统 API。

要新增平台能力时，先确认 Tauri 抽象层是否已覆盖，别直接调 Win32。

## 数据库

- 全部表在 `PGSCHEMA` 指定的 schema（默认 `desk_alarm`），靠 `search_path` 隔离
- `general_db` 是共用库，`public` 不许动
- 服务端是唯一的计时权威，`fired_at` 只由调度器写
- 不要引入 `pgcrypto` 之类需要装扩展的依赖，共用库里装扩展常没权限

## 环境变量

- 改 `.env` 后必须 `docker compose up -d --force-recreate`，`restart` 不重载环境变量
- 端口：`8091` 网关（`WEB_PORT`）、`8787` API 直连。`8090` 被本机别的服务占了，别用