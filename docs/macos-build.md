# macOS 构建

## 一句话

macOS 产物必须在 macOS 上构建，或者用 CI 的 macOS runner。没有 Mac 也能出，走 GitHub Actions。

## 为什么不能在这台 Windows 上构建

Tauri 的 macOS 产物（`.app` / `.dmg`）依赖：

- Xcode 的 macOS SDK
- Apple 的 `codesign` / `hdiutil` 工具链

这些只有 macOS 有。在 Windows 或 Linux 上 `cargo build --target x86_64-apple-darwin` 能过，但打包那一步必然失败。

代码本身没有平台障碍。`src-tauri/src/` 下三个文件（`windows.rs`、`tray.rs`、`commands.rs`）用的全是 Tauri 跨平台 API，没有一处 Win32 调用，托盘和全局热键插件两个平台都支持。`MacosLauncher::LaunchAgent` 已经在 `lib.rs` 里配好了。所以换台 Mac 直接就能构建，不需要改代码。

注意 `windows.rs` 这个文件名有误导性：它管的是「应用自己的三个窗口」的显隐和关不掉行为，不是 Windows 系统 API。

## 路线一：有 Mac

```bash
git clone <repo> && cd desk-alarm
./scripts/build-macos.sh
```

脚本会检查 Node、Rust、Xcode 完整版（不是只有 Command Line Tools），然后出 `.app` 和 `.dmg`。

架构选择：

```bash
./scripts/build-macos.sh universal    # Intel + Apple Silicon 通吃
./scripts/build-macos.sh aarch64      # 只 Apple Silicon
./scripts/build-macos.sh x86_64       # 只 Intel
```

装到本机：

```bash
cp -R app/src-tauri/target/release/bundle/macos/DeskAlarm.app /Applications/
```

没做签名和公证，首次打开被拦就：

```bash
xattr -cr /Applications/DeskAlarm.app
```

## 路线二：没有 Mac，用 CI

仓库里有 `.github/workflows/build.yml`，push 到 GitHub 后 Actions 会同时出 Windows 和 macOS 产物。

要装的东西（换一台机器时）：

- 推到 GitHub
- macOS runner 默认自带 Node 20 和 Xcode，不用额外装

### runner 标签不能写错

**用了已下线的标签，job 会永远卡在「Waiting for a runner to pick up this job」**——不报错、不失败，就是一直等，很容易被当成 CI 挂了。

GitHub 只保留最新两个 macOS 版本。下线了的标签：`macos-12`、`macos-13`。

当前用 `macos-15`（arm64）。**runner 架构和 Rust target 必须一致**，否则链接失败：

| runner | Rust target |
|---|---|
| `macos-15` | `aarch64-apple-darwin` |
| `macos-15-intel` | `x86_64-apple-darwin` |
| `macos-26` | `aarch64-apple-darwin` |

rustup target 的安装写在 workflow 里，本地不用管。

如果这台机器连 GitHub 慢，可以给 runner 配代理，或者直接用路线一。

## 一台 mac 和两台 Windows 一起用

服务端是共用的，装在哪台客户端上都连同一个地址。服务端由 CI 部署（推 tag 自动发布），不依赖任何一台机器开着 Docker。

所以只要每台机器能连到服务端的地址就行。装好后填同一个地址，多台设备共享同一份提醒。

## 服务端地址在哪填

- **登录页最上面**的「服务端地址」输入框，带「测试连接」按钮
- 登录后**点顶栏的连接状态**也能打开切换面板

填 `host:port` 不用带协议，会自动补 `http://`。改地址会清掉本地会话重新登录。

## 常见问题

**Gatekeeper 提示「无法验证开发者」**
没签名。`xattr -cr` 放行，或者右键打开选「打开」。

**`.dmg` 打不出来，提示 Xcode 不完整**
装的是 Command Line Tools。完整安装 Xcode.app，然后在 Xcode 里接受协议：
`sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`

**通知不响**
macOS 通知权限没给。系统设置 → 通知 → 找到「DeskAlarm」打开。

**热键 Ctrl+Shift+Space 被占用**
系统设置 → 键盘 → 快捷键 里换一个。热键是写死在 `src-tauri/src/lib.rs` 的 `CAPTURE_HOTKEY`。