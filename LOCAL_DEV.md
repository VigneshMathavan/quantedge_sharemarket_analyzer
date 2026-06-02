# QuantEdge — Local-First Development Guide

We are now **local-first**. The Vercel/Railway deploys stay alive as a read-only fallback but the source of truth is your machine.

## Daily flow

```
09:00 IST  →  Windows Task Scheduler auto-starts server  (or run start-quantedge.ps1)
09:15 IST  →  Market open, signals start firing, every signal logged to SQLite
15:30 IST  →  Market close. Active trades auto-exit on broker SL/TP or 15:15 time stop
16:00 IST  →  history.js prunes >24h-old trades from in-memory hot cache
                (SQLite keeps everything indefinitely)
23:00 IST  →  Daily backup → ~/QuantEdge_backups/quantedge_YYYY-MM-DD_HHMM.zip
                (rotates: keeps last 30 backups, ~10MB total)
```

## URLs

- **Trading view**: <http://localhost:4300/>
- **Ops dashboard**: <http://localhost:4300/ops.html>
- **Health JSON**: <http://localhost:4300/api/health>
- **Ops JSON**: <http://localhost:4300/api/ops>

## What lives where now

| Data | Location | Survives crashes? |
|---|---|---|
| Trades | `data/quantedge.db` (SQLite) + `data/week-trades.json` (legacy mirror) | Yes — WAL mode, fsync NORMAL |
| Signal journal | `data/quantedge.db` `signal_journal` table + `data/signal-journal.jsonl` mirror | Yes |
| Win-prob ML model | `data/quantedge.db` `kv_store` + `data/win-prob-model.json` mirror | Yes |
| Server logs | `data/logs/server-YYYY-MM-DD.log` | Yes |
| Backups | `~/QuantEdge_backups/quantedge_*.zip` | Yes, 30-day rotation |

## One-time setup

```powershell
# In an ELEVATED PowerShell window (Run as Administrator):
cd C:\Users\vigne\Downloads\quantedge
powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-tasks.ps1
```

This registers:
- `QuantEdge-AutoStart` — fires daily 09:00 AM, launches the server, auto-restarts on crash (up to 5 times)
- `QuantEdge-DailyBackup` — fires daily 23:00, zips DB + critical files

Verify with `Get-ScheduledTask -TaskName QuantEdge-*`.

## Manual operations

```powershell
# Start server right now
.\scripts\start-quantedge.ps1

# Take a backup right now
.\scripts\backup-db.ps1

# Or trigger via Task Scheduler
Start-ScheduledTask -TaskName QuantEdge-DailyBackup

# See today's logs
Get-Content data\logs\server-(Get-Date -Format yyyy-MM-dd).log -Tail 50

# Inspect the DB directly
sqlite3 data\quantedge.db "SELECT * FROM trades ORDER BY time DESC LIMIT 10"
```

## What no longer breaks across restarts

✅ Trade history — every trade is durably stored in SQLite the moment it closes
✅ Signal journal — every signal that fires is logged with full parameter snapshot
✅ Win-probability model — persisted as `kv_store` row, reloaded on boot
✅ Today's P&L pill — backed by SQLite, not ephemeral file
✅ "Today's trades" modal — same

## What you still control manually

- **Daily Upstox token refresh** (~3:30 AM IST expiry) — paste new JWT in `server/.env`
- **PC must be on 09:15–15:30 IST** for live trading (Scheduled Task wakes the server, you need the laptop awake)

## When to migrate to cloud (Supabase + better hosting)

Migrate ONLY when:
- 4+ consecutive weeks of profitable signals at STRONG tier (≥60% win rate)
- 200+ trades logged in SQLite for validation
- Need mobile access from outside home Wi-Fi (Tailscale is alternative)

Until then, every rupee saved on infrastructure goes into your trading account.
