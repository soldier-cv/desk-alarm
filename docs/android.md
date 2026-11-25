# Android 端

Android 端的 Rust 源码和 Windows 端共用，协议、解析、提醒逻辑（`api.ts` / `alarm.ts` / `theme.ts`）也共用；但**界面是独立的一套**：桌面三栏布局在窄屏上会被挤烂，所以 Android 走 `mobile.html` + `src/ui/mobile.ts` + `styles-mobile.css`，顶部状态 + 底部三页签（随手记 / 今天 / 设置）。`tauri.android.conf.json` 让 Android 只建 `main` 一个窗口并指向 `mobile.html`——若沿用桌面的三个窗口配置，capture 小窗会盖在最上面，表现为「打开就是空白随手记页」。

Android 端的差异：

1. **后台保活与锁屏即时到达**：`DeskAlarmKeepAliveService` 是常驻前台服务，在**原生层**持有 WebSocket、20 秒心跳和 `PARTIAL_WAKE_LOCK`。锁屏后 WebView 的 JS 会被系统冻结，若连接和通知留在 JS 里就会断心跳、到点弹不出，开屏才补发一串——所以原生服务自己连 `/stream`、自己弹通知。登录成功后 JS 通过 `plugin:push|start` 把服务端地址和 token 交给它。JS 侧仍保留一条 WS 只用于界面同步，但**不再弹系统通知**（避免和原生重复）。原生服务只认 `pursuit.nudge`（L1 静默、L2+ 通知）、`pursuit.followed` / `pursuit.deleted`（停铃）和 `welcome` 里的 `missed`（合成一条汇总）；重复间隔与桌面 `alarm.ts` 的阶梯一致、无次数上限，静音时段顺延。通知渠道保留 `deskalarm_strong` / `deskalarm_weak` 两个，但不再按强弱判定，而是按 nudge 等级。不依赖 Google 服务，国产 ROM 可用
2. **机器指纹**：`machine_id()` 在 Android 上读 `ro.serialno` 等系统属性，不是 Windows 注册表
3. **无设备锁定 / PIN**：桌面和移动端都不提供设备锁定与 PIN，锁屏后照常接收提醒。
4. **图标**：`icons/android/` 的 launcher 图标由桌面 `icon.png` 直接生成（无 Tauri 默认的黑色外框），`gen/android/.../res/` 里是同一份拷贝
5. **明文 HTTP**：服务端地址是用户在运行时填的 `http://<局域网 IP>:8091`，所以 `gen/android/app/build.gradle.kts` 里 `usesCleartextTraffic` 在 `defaultConfig` 就置为 `true`（Tauri 默认只给 debug 开，release 会被 Android 直接拦掉，表现为「测试连接连不上」）。`connect-src` 同理保持宽松，不能把具体地址写进白名单

## 当前状态：代码就绪，发版走 GitHub Actions

代码侧已经为移动端做好了适配：
- `lib.rs` 用 `#[cfg(desktop)]` / `#[cfg(mobile)]` 隔开桌面专属插件（托盘、开机自启、全局热键、单实例、多窗口），移动端保留通知插件，另注册 `push`（保活）与 `apk-installer`（应用内更新）两个 Android 插件
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

产物：`desk-alarm_<版本>_android-universal.apk`，同时出现在 GitHub Release 和 Gitee Release。移动端不装 Tauri updater 的静默安装包，但应用内更新仍会读 `latest.json`，取其中 `android` 条目的 APK 地址交给 `apk-installer` 用 DownloadManager 安装；用户也可以从 Release 页手动下载。

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

### 改了 Kotlin 必须本地编译再发 tag

推 `v*` tag 会触发 CI 编译全部 Kotlin 变体。Kotlin 的类型错误**只在 Gradle 编译期暴露**，tsc、cargo test、vite build 全查不出来——发版前只跑那几套检查就推 tag，等于把编译错误留给 CI，构建挂了还得补一个新 tag。所以动过 `gen/android/**/*.kt` 后，先本地真编译一遍：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
& .\app\src-tauri\gen\android\gradlew.bat -p app\src-tauri\gen\android :app:compileUniversalReleaseKotlin :app:compileArm64ReleaseKotlin
```

`universal` 是 CI 里报错的那个变体，务必编到。若 `~/.gradle/wrapper/dists` 缓存被清、wrapper 要联网下载 9.6.1 又连不上，从 `https://mirrors.cloud.tencent.com/gradle/gradle-9.6.1-bin.zip` 下载解压，直接用解压出的 `gradle.bat` 跑上面两个 task（Gradle 会自己拉 AndroidX/OkHttp 等依赖）。

踩过的坑：给 `NotificationChannel.setSound` 第二个参数传了 `AudioManager.STREAM_NOTIFICATION`（Int），它要的是 `AudioAttributes`，Kotlin 报 `argument type mismatch`，v1.2.1 因此 CI 构建失败，v1.2.2 修复。正确写法见 `DeskAlarmKeepAliveService.kt` 的 `applySoundSetting()`。

## 后台保活怎么工作

`MainActivity` 启动时调用 `startForegroundService`，拉起 `DeskAlarmKeepAliveService`（`gen/android/app/src/main/java/.../DeskAlarmKeepAliveService.kt`）。它做两件事：显示常驻通知把进程抬到前台优先级；**自己在原生层持有 WebSocket 和心跳**，按 `pursuit.nudge` 的等级弹通知，收到 `pursuit.followed` / `pursuit.deleted` 就停铃。WebView 里那条 WS 只做界面同步，不再弹系统通知，避免重复。

通知渠道是 `deskalarm_keepalive`（低重要性，不发声）。Android 13+ 首次启动会请求 `POST_NOTIFICATIONS`；不给权限服务照常运行，只是通知不进抽屉。Android 14+ 必须声明前台服务类型，这里用 `specialUse`（配合 `FOREGROUND_SERVICE_SPECIAL_USE` 权限和清单里的用途说明）——它不像 `dataSync` 那样在 Android 15+ 有 6 小时上限，适合常驻连接。不上 Play 商店，所以不需要在 Play Console 做类型声明。

这套方案不依赖 Google 服务，大陆国产 ROM 可用。用户仍然需要在系统设置里关掉电池优化、把应用锁在最近任务里——前台服务是必要条件，不是万能豁免。极端情况下（ROM 主动清理、网络切换）WS 仍可能断，重连后 `welcome` 会把离线期间的提醒补发。

## 已知的好消息

- 服务端 `transport` 是注册表式的（`server/src/transport/index.ts`），以后要接厂商通道（极光/个推）不用改调度器
- `deliveries` 表同时是跨端去重依据和 outbox，失败行带 `last_error`，排查一眼能看出是网络问题还是配置问题
- 服务端 20 秒收到一次心跳就刷新 `last_seen_at`；超过 3 分钟没心跳才标离线，不会被后台短断误判
