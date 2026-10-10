# Android 端

Android 端的代码逻辑和 Windows 端**完全共用**。真正只有 Android 的部分是两样东西：

1. **推送通道**。Android 会在后台杀进程，WebSocket 活不下来，只能靠 FCM 把进程叫醒。这是手机端存在的全部理由。
2. **通知里的快捷按钮**。Tauri 的 notification 插件里 Actions 只有移动端支持，所以 Android 的提醒交互其实比桌面端更好做，四个动作可以直接放进通知栏不用点开。

## 当前状态：卡在工具链，不是卡在代码

服务端侧已经全部就绪（`transport/fcm.ts`、devices 表的 `transport` / `push_token` / `pushReady` 字段），客户端的 `api.ts` 也已经是平台感知的（`DEFAULT_CONFIG` 里有 `deviceId`，`login` 会带 `transport`）。

**Android SDK 是空的**，`%LOCALAPPDATA%\Android\Sdk` 下只有 `platforms/android-36`：

| 组件 | 状态 |
|---|---|
| platform-tools（adb） | 缺 |
| NDK | 缺 |
| build-tools | 缺 |
| cmdline-tools | 缺 |
| JDK 21 | 有（`~/.jdks/liberica-21.0.7`） |
| rust android targets | 缺（只有 `x86_64-pc-windows-msvc`） |

NDK + build-tools 是 GB 级下载，这台机器连 GitHub 都超时（同款 NSIS 工具链就没下下来），所以**在这台机器上出不了 APK**。

## 装好工具链后要跑的命令

```powershell
# 1. Android Studio 里装组件，或用 sdkmanager 装
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "build-tools;34.0.0" "ndk;26.1.10909125" "platforms;android-35"

# 2. 环境变量
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = "$sdk\ndk\26.1.10909125"
# JAVA_HOME 指向 Android Studio 自带的 jbr，版本要对上

# 3. rust android targets
cd D:\project\desk-alarm\app
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# 4. 生成 Android 工程
npx tauri android init

# 5. 出包
npx tauri android build --apk
```

产物在 `app/src-tauri/gen/android/app/build/outputs/apk/universal/release/`，或者用 `--apk --target aarch64` 只出 arm64 的，体积小很多。

## Firebase 配置

服务端要三个环境变量，缺一个就到不了：

```bash
# .env
FCM_PROJECT_ID=your-project
FCM_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FCM_PRIVATE_KEY` 里的换行写成 `\n`，代码里会还原。

## Android 端要改的两处

`shared/types.ts` 不用动。客户端这边：

**登录时带上 fcm token**（`app/src/api.ts` 的 `api.login`）：

```ts
login: (passcode, deviceName, platform, pushToken?) =>
  req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      passcode, deviceName, platform,
      deviceId: loadConfig().deviceId,
      transport: platform === 'android' ? 'fcm' : 'ws',
      pushToken,
    }),
  }),
```

**收 FCM 消息**。服务端在 `data` 里带的是 `entryId` / `text` / `strength` / `serverTs`，Android 侧收到后照常调 `/entries/{id}/done` 或发 WS 的 `entry.ack` 就行。`strength=strong` 的走接管，`weak` 的走通知栏横幅。

## 已知的好消息

- 服务端 `transport` 是注册表式的（`server/src/transport/index.ts`），以后要加 WebPush 只需要实现一个 `Transport` 接口再 `registerTransport`，调度器和轮转器一行不用改
- `deliveries` 表同时是跨端去重的依据和 outbox，投递失败的行会带 `last_error`，排查时一眼能看出是 token 失效还是网络问题
- FCM 回执里 `UNREGISTERED` / `INVALID_ARGUMENT` 这类码会被标成 `fatal`，直接清掉那行让设备下次上线重新注册 token，不会无限重试

## 建议

先在 Windows 端把强弱提示这套用一两周。手机端的价值完全取决于「你人不在电脑前」的频率，如果发现一周都没几次，那 PWA 甚至不做都行。

真要做的时候，先确认这台机器能下 NDK，否则又是白等一轮超时。
