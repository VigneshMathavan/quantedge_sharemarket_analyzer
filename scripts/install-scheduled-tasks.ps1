# scripts/install-scheduled-tasks.ps1
#
# ONE-TIME setup script. Registers two Windows Scheduled Tasks:
#
#   1. QuantEdge-AutoStart   — launches the server daily at 09:00 IST
#   2. QuantEdge-DailyBackup — backs up the SQLite DB nightly at 23:00
#
# Run ONCE in an ELEVATED PowerShell session:
#   powershell -ExecutionPolicy Bypass -File install-scheduled-tasks.ps1
#
# To remove later:
#   Unregister-ScheduledTask -TaskName 'QuantEdge-AutoStart' -Confirm:$false
#   Unregister-ScheduledTask -TaskName 'QuantEdge-DailyBackup' -Confirm:$false

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$Root = 'D:\Projects\quantedge'

# ── Task 1: Auto-start server on LOGON + daily 09:00 IST + Windows startup ──
$StartScript = Join-Path $Root 'scripts\start-quantedge.ps1'
$StartAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""

# Three triggers — server is up whenever the PC is on
$TrigLogon = New-ScheduledTaskTrigger -AtLogOn
$TrigDaily = New-ScheduledTaskTrigger -Daily -At 9:00AM
$TrigStartup = New-ScheduledTaskTrigger -AtStartup
$StartSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 14) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew

# Unregister previous version if present
try { Unregister-ScheduledTask -TaskName 'QuantEdge-AutoStart' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Register-ScheduledTask `
    -TaskName 'QuantEdge-AutoStart' `
    -Description 'Launches QuantEdge trading server on logon, Windows startup, and daily 09:00 IST' `
    -Action $StartAction -Trigger @($TrigLogon, $TrigDaily, $TrigStartup) -Settings $StartSettings `
    -RunLevel Highest | Out-Null
Write-Host '✓ Installed QuantEdge-AutoStart  (logon + startup + daily 09:00 AM)' -ForegroundColor Green

# ── Desktop shortcut so user can open the dashboard with one click ──
try {
    $WScriptShell = New-Object -ComObject WScript.Shell
    $Desktop = [Environment]::GetFolderPath('Desktop')
    $Shortcut = $WScriptShell.CreateShortcut((Join-Path $Desktop 'QuantEdge.url'))
    $Shortcut.TargetPath = 'http://localhost:4300/'
    $Shortcut.Save()
    $OpsShortcut = $WScriptShell.CreateShortcut((Join-Path $Desktop 'QuantEdge Ops.url'))
    $OpsShortcut.TargetPath = 'http://localhost:4300/ops.html'
    $OpsShortcut.Save()
    Write-Host '✓ Created desktop shortcuts: QuantEdge + QuantEdge Ops' -ForegroundColor Green
} catch {
    Write-Host '⚠ Failed to create desktop shortcuts (non-fatal)' -ForegroundColor Yellow
}

# ── Task 2: Daily backup at 23:00 ──
$BackupScript = Join-Path $Root 'scripts\backup-db.ps1'
$BackupAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$BackupScript`""
$BackupTrigger = New-ScheduledTaskTrigger -Daily -At 11:00PM

try { Unregister-ScheduledTask -TaskName 'QuantEdge-DailyBackup' -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Register-ScheduledTask `
    -TaskName 'QuantEdge-DailyBackup' `
    -Description 'Daily SQLite + critical files backup to ~/QuantEdge_backups/' `
    -Action $BackupAction -Trigger $BackupTrigger `
    -RunLevel Highest | Out-Null
Write-Host '✓ Installed QuantEdge-DailyBackup (daily 11:00 PM)' -ForegroundColor Green

Write-Host ''
Write-Host 'Scheduled tasks installed. Verify with:' -ForegroundColor Cyan
Write-Host '  Get-ScheduledTask -TaskName QuantEdge-*'
Write-Host ''
Write-Host 'Run backup right now (test):' -ForegroundColor Cyan
Write-Host '  Start-ScheduledTask -TaskName QuantEdge-DailyBackup'
