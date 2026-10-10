#!/usr/bin/env pwsh
# 在 Windows 上构建 DeskAlarm。
#
# 两种产物，默认都出：
#   -noInstaller   只出裸 exe，秒级，双击即用，适合自己测
#   （默认）       出 NSIS 安装包，会去下载打包工具链
#
# 用法：
#   .\scripts\build-windows.ps1
#   .\scripts\build-windows.ps1 -NoInstaller

[CmdletBinding()]
param([switch]$NoInstaller)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Yellow }

Say '检查前置依赖'
foreach ($c in 'node', 'cargo') {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) {
        throw "没装 $c"
    }
}
# node -p 的表达式里带引号，经过 PowerShell 和 cmd 两层会被吃掉。改用临时文件绕开。
$probe = Join-Path $env:TEMP 'deskalarm-nodever.cjs'
Set-Content -Path $probe -Value 'console.log(process.versions.node)' -Encoding ASCII
$nodeVer = (node $probe).Trim()
Remove-Item $probe -Force
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node 版本太老（$nodeVer），需要 20+" }
Write-Host "  Node    $nodeVer"
Write-Host "  Rust    $(rustc --version)"
$target = rustc -vV | Select-String '^host:' | ForEach-Object { $_.ToString().Split(':')[1].Trim() }
if ($target -notlike '*windows-msvc*') {
    Write-Warning "当前默认 target 是 $target，Tauri 需要 msvc 工具链。装：rustup default stable-msvc"
}

Say '安装依赖'
foreach ($d in 'app', 'server') {
    if (-not (Test-Path "$d\node_modules")) {
        Push-Location $d
        npm install
        Pop-Location
    }
}

Say '构建前端'
Push-Location app
npm run build

if ($NoInstaller) {
    Say '构建 exe（不出安装包）'
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = npx tauri build --no-bundle 2>&1
    $ErrorActionPreference = $prev
    $out | Select-String 'Finished|Built application' | ForEach-Object { "  $_" }
    $fatal = $out | Select-String 'failed to|error\[E|error:'
    if ($fatal) { throw ($fatal -join "`n") }
    $exe = 'src-tauri\target\release\deskalarm.exe'
    Write-Host "`n产物: $((Resolve-Path $exe).Path)  ($([math]::Round((Get-Item $exe).Length/1MB,2)) MB)"
    Write-Host '双击即用，不需要安装。'
} else {
    Say '构建 NSIS 安装包'

    # tauri 下 NSIS 工具链时会在校验不通过后把缓存删掉重下，网络慢就死循环超时。
    # 先手动铺好，tauri 校验就能过。
    $nsisDir = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
    if (-not (Test-Path (Join-Path $nsisDir 'makensis.exe'))) {
        Write-Host '首次构建：手动准备 NSIS 工具链（避免 tauri 反复重下超时）'
        $zip = Join-Path $env:TEMP 'nsis-3.11.zip'
        $url = 'https://ghproxy.net/https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
        Write-Host "  下载 $url"
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 240 -UseBasicParsing
        Write-Host ("  下载完成 {0} MB" -f [math]::Round((Get-Item $zip).Length / 1MB, 2))

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $stage = Join-Path $env:TEMP 'nsis-extract'
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
        $src = Join-Path $stage 'nsis-3.11'
        if (Test-Path $nsisDir) { Remove-Item $nsisDir -Recurse -Force }
        New-Item -ItemType Directory -Path $nsisDir -Force | Out-Null
        Copy-Item -Path (Join-Path $src '*') -Destination $nsisDir -Recurse -Force
        Remove-Item $stage -Recurse -Force
        Write-Host "  已铺到 $nsisDir"
    }

    # npx / npm 会把 Info、进度这类正常输出写到 stderr，
    # 在 ErrorActionPreference=Stop 下会被当成错误抛出来。
    # 临时放宽，逐行自己挑错误。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = npx tauri bundle --bundles nsis 2>&1
    $ErrorActionPreference = $prev
    $out | ForEach-Object { "  $_" }
    $fatal = $out | Select-String 'failed to bundle|Error:|error:'
    if ($fatal) { throw ($fatal -join "`n") }

    $nsis = 'src-tauri\target\release\bundle\nsis'
    if (Test-Path $nsis) {
        Write-Host "`n产物:"
        Get-ChildItem "$nsis\*.exe" | ForEach-Object {
            Write-Host "  $($_.FullName)  ($([math]::Round($_.Length/1MB,2)) MB)"
        }
    }
}

Pop-Location
Say '完成'