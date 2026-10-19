# 应用内更新

桌面端自带版本检查：**Gitee 优先、GitHub 降级**。入口是顶栏「更新」按钮。

涉及文件：`app/src-tauri/src/update.rs`（Rust）、`app/src/ui/main.ts`（按钮）。

## 为什么不用插件内置的 `endpoints` 轮询

官方 `tauri-plugin-updater` 的配置形如：

```json
{ "plugins": { "updater": { "pubkey": "...", "endpoints": ["..."] } } }
```

它只是「按顺序试 URL，第一个成功就用」。而 Gitee 镜像是**可能静默落后**的：
`build.yml` 里同步那一步标了 `continue-on-error`，附件上传失败不阻断发版，
所以「镜像停在旧版」是一种会长期存在的状态，而不是不该发生的意外。

只配 endpoints 的后果：Gitee 返回一个旧 tag ⇒ 插件判定「已是最新」，
而它**不会再去看 GitHub**。用户就卡在旧版，界面上毫无异常。

所以这里自己拉两份 `latest.json`，做完版本比较与落后复核后，
再把确定的那一条 endpoint 交给插件去下载安装。

两条通道的判定规则（两个方向都不能搞错）：

- 探测到 GitHub 更新 ⇒ **用**它（镜像在骗人，用户必须能更新）
- 探测失败 ⇒ **维持**「已是最新」（拿不到证据不等于有更新；
  反过来处理会让断网时凭空提示有新版，比不检查更糟）

## 为什么用官方插件而不是自己下载安装

自写 updater 的代价不在"拉 JSON + 下文件"，而在**安装那一半**：
Windows 要处理 UAC 提权与"运行中的 exe 无法自删"的换名接力，
macOS 要挂载 dmg 并替换 `.app`。这些都没有跨平台 API，
只能按平台各写一套，且失败现场极难复现。

官方插件要求 Release 里有 `latest.json` + `.sig`、校验依赖打包期注入的
`pubkey`，代价是**必须养一对签名密钥**。本仓库接受了这点：
签名校验、UAC 提权静默安装、macOS 的 `.app` 替换全部由插件负责。

代价写在下面「签名密钥」一节 —— 私钥丢了发不出新版本，泄露了能被人签假包。

## 签名密钥

`tauri.conf.json` 的 `plugins.updater.pubkey` 是公钥，可以公开。

私钥在 GitHub Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`，打包时由
`TAURI_SIGNING_PRIVATE_KEY` 环境变量注入产生 `.sig` 文件。
**私钥丢失或泄露会导致无法签发新版本，或被人签发包**，需重新生成并
发布一个带新公钥的版本。

生成方式（当前这对已生成，无密码）：

```bash
cd app && npx tauri signer generate --ci -w ~/.tauri/deskalarm.key
```

## latest.json 的生成

`createUpdaterArtifacts: true` 让打包器产出 `.sig`。CI 需要把
「版本 + 各平台的 url 与 signature」拼成静态 JSON 上传到 Release，
客户端才读得到。格式见 Tauri 官方文档的 Static JSON File 一节。
