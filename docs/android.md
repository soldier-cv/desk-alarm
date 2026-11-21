# Android 端

Android 端的 Rust 源码和 Windows 端共用，协议、解析、提醒逻辑（`api.ts` / `alarm.ts` / `theme.ts`）也共用；但**界面是独立的一套**：桌面三栏布局在窄屏上会被挤烂，所以 Android 走 `mobile.html` + `src/ui/mobile.ts` + `styles-mobile.css`，顶部状态 + 底部三页签（随手记 / 今天 / 设置）。`tauri.android.conf.json` 让 Android 只建 `main` 一个窗口并指向 `mobile.html`——若沿用桌面的三个窗口配置，capture 小窗会盖在最上面，表现为「打开就是空白随手记页」。

Android 端的差异：

1. **后台保活**：用常驻通知的前台服务把进程抬到前台优先级，让 WebSocket 在后台不断线。桌面端本来就是常驻进程，所以两端都走同一条 WS 通道，服务端不需要 FCM 之类的第二通道
2. **机器指纹**：`machine_id()` 在 Android 上读 `ro.serialno` 等系统属性，不是 Windows 注册表
3. **设备锁定只在桌面端提供**：Windows 用会话检测（`session.rs`，仅 `#[cfg(windows)]`）。移动端切后台、锁屏都照常接收提醒；设置页不显示 PIN/锁定，服务端也会拒绝移动端的锁定请求
4. **图标**：`icons/android/` 的 launcher 图标由桌面 `icon.png` 直接生成（无 Tauri 默认的黑色外框），`gen/android/.../res/` 里是同一份拷贝
5. **明文 HTTP**：服务端地址是用户在运行时填的 `http://<局域网 IP>:8091`，所以 `gen/android/app/build.gradle.kts` 里 `usesCleartextTraffic` 在 `defaultConfig` 就置为 `true`（Tauri 默认只给 debug 开，release 会被 Android 直接拦掉，表现为「测试连接连不上」）。`connect-src` 同理保持宽松，不能把具体地址写进白名单

## 当前状态：代码就绪，发版走 GitHub Actions

代码侧已经为移动端做好了适配：
- `lib.rs` 用 `#[cfg(desktop)]` / `#[cfg(mobile)]` 隔开桌面专属插件（托盘、开机自启、全局热键、单实例、updater、多窗口），移动端只保留通知插件
- `machine_id()` 有 Android 分支；`platform()` 会返回 `android`，前端据此隐藏桌面专属按钮
- `shared/types.ts` 的 `Platform` 含 `android`

**发版不用本机 SDK**：推 `v*` tag 后，GitHub Actions 的 `android` job 在 ubuntu-latest 上补齐 NDK/build-tools，打出 APK 并挂到同一个 Release，再由 `gitee-release` job 同步到 Gitee。Runner 自带 Android SDK，本地这套步骤只用于离线调试。

## 发版：APK 签名与 Secrets

Android 只允许同证书覆盖安装。debug 证书的签名每轮 runner 现生成，拿它发版会导致用户下一版 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，所以发版链路**必须有正式签名**：

1. 生成一次发布密钥（只做一次，丢了就无法给现有用户升级）：

   ```bash
   keytool -genkeypair -v -keystore release.jks -alias deskalarm \
     -keyalg RSA -keysize 2048 -validity 10000
   # 记下 storePassword / keyPassword；下面四个值要和 keystore 一起保存
   ```

2. 取签名指纹（CI 用它强校验产物，防止 Gradle 静默回退 debug 签名）：

   ```bash
   keytool -list -v -keystore release.jks -alias deskalarm | grep 'SHA256:'
   # 形如 3A:9F:...，去掉冒号与空白后就是 ANDROID_CERT_SHA256
   ```

3. 在 GitHub 仓库 Settings → Secrets 添加：

   | Secret | 值 |
   |---|---|
   | `ANDROID_KEYSTORE_B64` | `base64 -w0 release.jks`（Windows 用 `certutil` 或 Git Bash） |
   | `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
   | `ANDROID_KEY_ALIAS` | 如 `deskalarm` |
   | `ANDROID_KEY_PASSWORD` | key 口令 |
   | `ANDROID_CERT_SHA256` | 上一步的 SHA-256 指纹（冒号可留可去） |

CI 会把 keystore 解码到 `gen/android/app/release.jks`，把口令写进 `gen/android/keystore.properties`。两者都被 `.gitignore` 挡住，不会入库。发版前检查 Secrets 齐全，打完包用 `apksigner verify --print-certs` 比对指纹，任一不符直接让 job 失败。

APK 版本号由 tag 决定：`scripts/set-version.mjs` 更新 `tauri.conf.json`，Tauri 据此生成 `versionName` 和 `versionCode`（`major*1000000 + minor*1000 + patch`）。tag 不递增会导致用户看不到更新。

产物：`desk-alarm_<版本>_android-universal.apk`，同时出现在 GitHub Release 和 Gitee Release。移动端没有 updater 插件，不读 `latest.json`，用户从 Release 页手动下载安装。

## 构建步骤（离线调试，在有 SDK 的机器上）

### 1. 装 SDK 组件

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "build-tools;36.0.0" "ndk;26.1.10909125" "platforms;android-36"
```

### 2. 设环境变量

```powershell
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = "$sdk\ndk\26.1.10909125"
# JAVA_HOME 指向 Android Studio 自带的 jbr（或装 JDK 17/21）
```

### 3. 装 Rust android target

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### 4. 一键构建

```powershell
.\scripts\build-android.ps1                 # universal APK
.\scripts\build-android.ps1 -Target aarch64  # 只打 arm64，体积小很多
.\scripts\build-android.ps1 -Version v0.2.0  # 按 tag 版本号打包
```

脚本会自动判断要不要跑 `npx tauri android init`（`gen/android` 不存在时才跑，避免覆盖本地 gradle 改动），然后 `vite build` + `tauri android build --apk`。

产物在 `app/src-tauri/gen/android/app/build/outputs/apk/`。

> 首次跑会生成 `app/src-tauri/gen/android`，这是 Tauri 的 Android 工程骨架（Gradle 项目），由 `tauri android init` 产出，**不要手工编辑**；生成后提交到仓库，后续机器不用再 init。

## 后台保活怎么工作

`MainActivity` 启动时调用 `startForegroundService`，拉起 `DeskAlarmKeepAliveService`（`gen/android/app/src/main/java/.../DeskAlarmKeepAliveService.kt`）。它只做一件事：显示一条常驻通知，把进程抬到前台优先级，WebView 里的 WebSocket 因此不会被系统回收。提醒的接收、心跳、`welcome` 补发仍然全在 JS 侧，跟桌面端完全一样。

通知渠道是 `deskalarm_keepalive`（低重要性，不发声）。Android 13+ 首次启动会请求 `POST_NOTIFICATIONS`；不给权限服务照常运行，只是通知不进抽屉。Android 14+ 必须声明前台服务类型，这里用 `specialUse`（配合 `FOREGROUND_SERVICE_SPECIAL_USE` 权限和清单里的用途说明）——它不像 `dataSync` 那样在 Android 15+ 有 6 小时上限，适合常驻连接。不上 Play 商店，所以不需要在 Play Console 做类型声明。

这套方案不依赖 Google 服务，大陆国产 ROM 可用。用户仍然需要在系统设置里关掉电池优化、把应用锁在最近任务里——前台服务是必要条件，不是万能豁免。极端情况下（ROM 主动清理、网络切换）WS 仍可能断，重连后 `welcome` 会把离线期间的提醒补发。

## 已知的好消息

- 服务端 `transport` 是注册表式的（`server/src/transport/index.ts`），以后要接厂商通道（极光/个推）不用改调度器
- `deliveries` 表同时是跨端去重依据和 outbox，失败行带 `last_error`，排查一眼能看出是网络问题还是配置问题
- 服务端 20 秒收到一次心跳就刷新 `last_seen_at`；超过 3 分钟没心跳才标离线，不会被后台短断误判
