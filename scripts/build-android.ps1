#!/usr/bin/env pwsh
# 在有 Android SDK 的机器上构建 DeskAlarm 的 APK。
# 这台开发机没有 NDK/cmdline-tools，出不了包，所以脚本只在有完整环境时跑。
#
# 用法：
#   .\scripts\build-android.ps1                    # 打 universal APK
#   .\scripts\build-android.ps1 -Target aarch64     # 只打 arm64，体积小很多
#   .\scripts\build-android.ps1 -Version v0.2.0     # 按 tag 版本号打包
#
# 前置条件见 docs/android.md：ANDROID_HOME / NDK / cmdline-tools / JDK / rust android target。

[CmdletBinding()]
param(
    [string]$Target = '',
    [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Yellow }

if ($Version) {
    Say "设置版本号 $Version"
    node scripts/set-version.mjs $Version
    if ($LASTEXITCODE -ne 0) { throw '版本号设置失败' }
}

Say '检查 Android 环境'
$sdk = $env:ANDROID_HOME
if (-not $sdk -or -not (Test-Path $sdk)) {
    throw "ANDROID_HOME 没设或路径不存在。先按 docs/android.md 装好 SDK 再跑。"
}
Write-Host "  ANDROID_HOME = $sdk"

# tauri android init 只需要一次；gen 目录已存在就跳过，避免覆盖本地 gradle 改动
$genDir = 'app\src-tauri\gen\android'
if (-not (Test-Path $genDir)) {
    Say '首次构建：生成 Android 工程骨架'
    Push-Location app
    npx tauri android init
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw 'tauri android init 失败，检查 SDK / cmdline-tools / JDK' }
    Write-Host '  gen/android 已生成，下次不用再生成'
} else {
    Write-Host '  gen/android 已存在，跳过 init'
}

Say '构建前端'
Push-Location app
npm run build
Pop-Location

Say '构建 APK'
Push-Location app
if ($Target) {
    npx tauri android build --apk --target $Target
} else {
    npx tauri android build --apk
}
Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'APK 构建失败，看上面的报错' }

Say '产物'
$apkDir = 'app\src-tauri\gen\android\app\build\outputs\apk'
if (Test-Path $apkDir) {
    Get-ChildItem $apkDir -Recurse -Filter '*.apk' | ForEach-Object {
        Write-Host "  $($_.FullName)  ($([math]::Round($_.Length/1MB,2)) MB)"
    }
} else {
    Write-Warning "没找到 APK 目录：$apkDir"
}
