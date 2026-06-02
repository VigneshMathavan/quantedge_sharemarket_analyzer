# scripts/start-quantedge.ps1
#
# Launches the QuantEdge server. Used by:
#   1. Windows Task Scheduler at 09:00 IST (15 min before market open)
#   2. Manual desktop shortcut for on-demand starts
#
# Logs stdout/stderr to data/logs/server-YYYY-MM-DD.log
# Auto-restarts the server if it crashes (basic supervisor).
#
# Setup auto-start at 09:00 IST (one-time, in elevated PowerShell):
#   $A = New-ScheduledTaskAction -Execute 'powershell.exe' `
#         -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Projects\quantedge\scripts\start-quantedge.ps1'
#   $T = New-ScheduledTaskTrigger -Daily -At 9:00AM
#   $S = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 12)
#   Register-ScheduledTask -TaskName 'QuantEdge-AutoStart' -Action $A -Trigger $T -Settings $S -RunLevel Highest

$ErrorActionPreference = 'Continue'
$Root = 'D:\Projects\quantedge'
$ServerDir = Join-Path $Root 'server'
$LogDir = Join-Path $Root 'data\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$Today = Get-Date -Format 'yyyy-MM-dd'
$LogFile = Join-Path $LogDir "server-$Today.log"

# Quick bail-out if already running on port 4300
$existing = Get-NetTCPConnection -LocalPort 4300 -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "QuantEdge already listening on port 4300 (PID $($existing.OwningProcess[0]))" -ForegroundColor Yellow
    Add-Content $LogFile "[$(Get-Date -Format 's')] start skipped — already running"
    exit 0
}

Add-Content $LogFile "[$(Get-Date -Format 's')] starting server …"
Set-Location $ServerDir

# Restart loop — if server crashes, restart up to 5 times in 10 min
$restartCount = 0
$windowStart = Get-Date

while ($true) {
    & node index.js *>> $LogFile
    $exitCode = $LASTEXITCODE
    Add-Content $LogFile "[$(Get-Date -Format 's')] server exited code $exitCode"

    # Reset counter if more than 10 min since last batch
    if (((Get-Date) - $windowStart).TotalMinutes -gt 10) {
        $restartCount = 0
        $windowStart = Get-Date
    }
    $restartCount++
    if ($restartCount -ge 5) {
        Add-Content $LogFile "[$(Get-Date -Format 's')] too many crashes — giving up"
        break
    }
    Start-Sleep -Seconds 10
}
