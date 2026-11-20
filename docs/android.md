# Android 端

Android 端的代码逻辑和 Windows 端**完全共用同一份前端和 Rust 源码**。真正只有 Android 的差异是两样：

1. **推送通道**：Android 后台会杀进程，WebSocket 活不下来，靠 FCM 把进程叫醒
2. **机器指纹**：`machine_id()` 在 Android 上读 `ro.serialno` 等系统属性，不是 Windows 注册表
3. **设备锁定只在桌面端提供**：Windows 用会话检测（`session.rs`，仅 `#[cfg(windows)]`）。移动端切后台、锁屏都照常接收 FCM 提醒；设置页不显示 PIN/锁定，服务端也会拒绝移动端的锁定请求

## 当前状态：代码就绪，缺构建环境

代码侧已经为移动端做好了适配：
- `lib.rs` 用 `#[cfg(desktop)]` / `#[cfg(mobile)]` 隔开桌面专属插件（托盘、开机自启、全局热键、单实例、updater、多窗口），移动端只保留通知插件
- `machine_id()` 有 Android 分支；`platform()` 会返回 `android`，前端据此隐藏桌面专属按钮
- `shared/types.ts` 的 `Platform` 含 `android`

**这台开发机缺 NDK / cmdline-tools / build-tools**，出不了包。有完整 Android SDK 的机器按下面步骤构建。

## 构建步骤（在有 SDK 的机器上）

### 1. 装 SDK 组件

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "build-tools;35.0.0" "ndk;26.1.10909125" "platforms;android-35"
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

## Firebase 配置（FCM 推送要用）

服务端要三个环境变量，缺一个 Android 到点就不会响：

```bash
# .env
FCM_PROJECT_ID=your-project
FCM_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FCM_PRIVATE_KEY` 里的换行写成 `\n`，代码里会还原。Android 侧还要把 `google-services.json` 放进 `gen/android/app/`，并用支持 FCM 的插件——**这部分还没接**，当前 Android 到点靠「下次上线时 welcome 补发」兜底。

## 已知的好消息

- 服务端 `transport` 是注册表式的（`server/src/transport/index.ts`），加通道不用改调度器
- `deliveries` 表同时是跨端去重依据和 outbox，失败行带 `last_error`，排查一眼能看出是 token 失效还是网络问题
- FCM 回执里 `UNREGISTERED` / `INVALID_ARGUMENT` 会标 `fatal`，清掉那行让设备重新注册，不会无限重试
