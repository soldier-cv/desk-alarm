# DeskAlarm 网关端口从 8090 迁到 8091
# 原因：8090 上跑着一个别的 Python/FastAPI 服务，会抢走 127.0.0.1:8090 的回环流量，
#       导致我们的网关看起来"起来了"但请求全打到别人身上。
#
# 用法：右键「以管理员身份运行」PowerShell，或在管理员终端里执行
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-firewall-8091.ps1

$ErrorActionPreference = 'Stop'

Write-Host '删除旧的 8090 规则...'
$old = Get-NetFirewallRule -DisplayName 'DeskAlarm 8090' -ErrorAction SilentlyContinue
if ($old) {
    $old | Remove-NetFirewallRule
    Write-Host '  已删除'
} else {
    Write-Host '  没有旧规则，跳过'
}

Write-Host '建立 8091 规则...'
Get-NetFirewallRule -DisplayName 'DeskAlarm 8091' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'DeskAlarm 8091' `
    -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort 8091 -Profile Any `
    -RemoteAddress 100.64.0.0/24 | Out-Null
Write-Host '  已建立'

Write-Host ''
Write-Host '当前规则：'
Get-NetFirewallRule -DisplayName 'DeskAlarm 8*' -ErrorAction SilentlyContinue |
    Select-Object DisplayName, Enabled, Action |
    Format-Table -AutoSize