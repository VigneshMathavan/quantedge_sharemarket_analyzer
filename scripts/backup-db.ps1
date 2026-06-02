# scripts/backup-db.ps1
#
# Daily backup of QuantEdge SQLite + critical data files.
# Schedule via Windows Task Scheduler to run at 23:00 daily.
#
# Setup (one-time, in elevated PowerShell):
#   $A = New-ScheduledTaskAction -Execute 'powershell.exe' `
#         -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\Users\vigne\Downloads\quantedge\scripts\backup-db.ps1'
#   $T = New-ScheduledTaskTrigger -Daily -At 11:00PM
#   Register-ScheduledTask -TaskName 'QuantEdge-DailyBackup' -Action $A -Trigger $T -RunLevel Highest

$ErrorActionPreference = 'Stop'
$Root = 'C:\Users\vigne\Downloads\quantedge'
$BackupRoot = "$env:USERPROFILE\QuantEdge_backups"
if (-not (Test-Path $BackupRoot)) { New-Item -ItemType Directory -Path $BackupRoot | Out-Null }

$Stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$BackupFile = Join-Path $BackupRoot "quantedge_$Stamp.zip"

# Files / dirs to back up (skip huge historical/ — that's regeneratable from Upstox)
$ItemsToBackup = @(
    "$Root\data\quantedge.db",
    "$Root\data\quantedge.db-wal",
    "$Root\data\quantedge.db-shm",
    "$Root\data\week-trades.json",
    "$Root\data\signal-journal.jsonl",
    "$Root\data\win-prob-model.json",
    "$Root\data\strategy-weights.json",
    "$Root\data\calibration.json",
    "$Root\data\training_NIFTY.json",
    "$Root\server\.env"
) | Where-Object { Test-Path $_ }

if ($ItemsToBackup.Count -eq 0) {
    Write-Host "Nothing to back up." -ForegroundColor Yellow
    exit 0
}

Compress-Archive -Path $ItemsToBackup -DestinationPath $BackupFile -Force
$Size = (Get-Item $BackupFile).Length / 1KB
Write-Host "[$Stamp] Backup → $BackupFile ($([math]::Round($Size, 1)) KB)" -ForegroundColor Green

# Rotation — keep last 30 daily backups, delete older
Get-ChildItem $BackupRoot -Filter 'quantedge_*.zip' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 30 |
    ForEach-Object {
        Write-Host "Pruning old backup: $($_.Name)"
        Remove-Item $_.FullName -Force
    }

Write-Host "Done. Backup dir size: $([math]::Round((Get-ChildItem $BackupRoot | Measure-Object -Property Length -Sum).Sum / 1MB, 1)) MB"
