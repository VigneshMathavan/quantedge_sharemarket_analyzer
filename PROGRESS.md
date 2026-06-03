# QuantEdge — Progress Log

A chronological list of everything built, from project start to current state. Local-first development since the user said "no push." All commits live in `D:\Projects\quantedge` and have NOT been pushed to GitHub.

---

## Foundation (pre-localization era — committed to GitHub originally)

- Backend skeleton: Node.js + Express + WebSocketServer
- Frontend: Vanilla HTML/JS with TradingView Lightweight Charts
- Broker integrations: Breeze Connect (mock), Kotak Neo (auto-TOTP), Upstox (PRIMARY, dual-token)
- IndianAPI hybrid provider (Yahoo + indianapi.in)
- 13 trading strategies: ORB, VWAP Continuation, Supertrend+EMA, RSI Reversion, BB Squeeze, Momentum Burst, Range Expansion, Inside Bar, VWAP Cross, EMA Pullback, Volume Climax, CPR Breakout, CPR Reversal
- Strategy orchestrator + confluence engine
- AI Approval Engine — 12-rule veto + A+/A/B/C/Avoid grading
- Market Regime classifier (8 classes)
- Path Forecaster — logistic + Random Forest (465k samples), Sunday auto-retrain cron
- Greeks engine (Black-Scholes Δ/Γ/Θ/V)
- Gamma blast detector
- Budget-aware multi-strike scanner
- Profit-taking playbook engine
- News pulse engine (RSS + sentiment)
- Event awareness gate (RBI / FOMC / CPI calendar)
- CPR (Central Pivot Range) indicator + strategy
- Mid-candle pattern detector (25+ patterns)
- 60+ feature engineering library
- 10-year historical fetch pipeline (NIFTY/SENSEX/BANKNIFTY/FINNIFTY × 7 TFs)
- Walk-forward backtester
- Confidence calibration tracker
- Active trade tracker with full SL/T1/T2 monitor + exit warnings
- WebSocket sub-second tick streaming
- Always-on startup watchdog
- 1-click OAuth token refresh
- Possible signals panel (near-misses)
- Vercel + Railway deployment (later abandoned for local-first)
- NATURALGAS commodity added (stitched-contract historical fetch)
- Expiry-day elite mode (Max Pain + OI shift + theta sanity)
- Tier-based signal surfacing (POTENTIAL / LIKELY / STRONG / ELITE)
- Critical bug fixes: stale entry SL, synthetic premium ban, chain freshness, topbar LTP staleness

---

## Local-first migration + 4 weeks of layered work (NOT pushed)

### Week 1 — Foundation (commit `b35603e`)

- SQLite persistence layer (`server/db.js`) with WAL mode
- Schema: trades, signal_journal, kv_store, system_log
- Auto-migration on first boot from legacy JSON files (idempotent)
- Ops dashboard at `/ops.html` — DB stats, signals, system logs, auto-refresh 5s
- `/api/ops` diagnostic endpoint
- Windows scheduled tasks: `scripts/install-scheduled-tasks.ps1`
  - QuantEdge-AutoStart — daily 09:00 IST + logon + startup triggers
  - QuantEdge-DailyBackup — daily 23:00, 30-day rotation
- Server launcher with crash auto-restart: `scripts/start-quantedge.ps1`
- Daily backup script: `scripts/backup-db.ps1` → `~/QuantEdge_backups/`
- `LOCAL_DEV.md` — operations playbook
- Project relocated from `C:\Users\vigne\Downloads\quantedge` to `D:\Projects\quantedge`

### Week 2 — Parameter Expansion Engine (commit `a03adb6`)

- `server/parameter-engine.js` — 50+ master-spec indicators in one pass
- Pillars: Trend (EMA 9/20/50/100/200, ADX, +DI, -DI, stack), VWAP (slope, distance, bands, reclaim/rejection), Volume (delta, cumulative delta, acceleration, exhaustion), Volatility (ATR state, HV, BB width, squeeze), Structure (HH/HL/LH/LL, BOS, CHoCH), SMC (FVG, liquidity sweep), Price Action (8 candle patterns), RSI, Chain (PCR, ATM IV, OI)
- `computeFactorScores()` — per-pillar 0-100 derived score given signal side
- `/api/parameters/:symbol` inspection endpoint
- Per-factor "🧠 Confidence Breakdown" UI on signal card with color-coded bars

### Week 3 — Historical Intelligence + MTF + Backtest (commit `daa5f3a`)

- `server/similarity-engine.js` — 24-dim parameter fingerprint, cosine similarity matcher against `signal_journal`
- `strategyBacktestSummary()` — 10-year per-strategy win rate / profit factor / Sharpe / max DD / expectancy
- `server/mtf-alignment.js` — parallel bias across all 7 TFs (1m/3m/5m/15m/30m/60m/Daily)
- Signal card blocks: "⏱ Multi-TF Alignment", "📚 Historical Match", "📊 Strategy Backtest (10y)"

### Week 4 — AI Learning + Mass Seed + Cross-Index (commit `cbef94f`)

- `server/factor-learner.js` — point-biserial correlation between each pillar's score and trade outcome → adaptive weight multiplier [0.4, 1.6]
- Nightly retrain at 23:30 IST
- `/api/learner/weights` + `/api/learner/retrain` endpoints
- `server/oi-flow.js` — LONG_BUILDUP / SHORT_BUILDUP / LONG_UNWIND / SHORT_COVER / WRITER_DOMINANT
- `server/multi-index-scanner.js` — parallel orchestrator on NIFTY+BANKNIFTY+FINNIFTY+SENSEX
- `server/equity-curve.js` — running cumulative P&L with peak / drawdown stats
- `server/seed-backtest.js` — **MASS BACKTEST SEEDER**
- Ran the seeder: **1,25,582 historical signals + 1,25,582 simulated trades** in 1.9 min
- Live chain attached to every signal (`chainSnapshot` block on card)
- Auto-exit on broker-confirmed SL_HIT / TIME_STOP
- 16:00 IST trade retention sweep
- Today's P&L pill in topbar (clickable → today's trades modal with equity sparkline SVG)

### Hot-fixes for live trading (commit `7a37b59`)

- Critical exit-pricing bug fixed (was recording exit=0 → fake loss)
- Frontend prompts user for exit price if broker chain unavailable
- Server-side safety net does same chain lookup
- Active-trade card LOCK — new candidate signals stop flashing while position open
- Pre-SL approach warning (75% of way to SL → severity 70 alert)
- Pre-T1 approach warning
- Factor learner: now ignores backtest_seed source once ≥50 live trades exist
- Chain refresh bumped 3s → 2s during market hours

### Trade-correction tool

- Retroactively fixed broken SENSEX 74100CE trade (exit ₹0 → ₹543.53, pnl -₹7,994 → +₹2,877)
- Backend `/api/history/week` merge logic flipped — SQLite now wins on overlap
- Fixed `week-trades.json` directly

### Master Option Buying Intelligence Layer (commit `04987cd`)

Five new master-spec modules:

- `server/expected-move.js` — Conservative / Average / Aggressive move % from history (P9)
- `server/cross-index-leadership.js` — leader / laggard / aligned detection (P12)
- `server/iv-forecast.js` — expansion / compression probability from IV/HV ratio + event + squeeze + ATR (P6)
- `server/premium-explosion.js` — probability of 30%+ option move with contributor breakdown (P7)
- `server/signal-quality.js` — A+/A/B/C/D/F grade + Failure Predictor (P14 + P10)
- Sidebar collapsibles (Cross-Index Scan / Recent Signals / Week Trades) → always expanded

### Chain-Keeper + AI Narrative + Exit Intel + Risk + Institutional (commit `7ec90cc`)

- `server/chain-keeper.js` — **PERSISTENT BACKGROUND CHAIN CACHE**
  - Per-symbol poller (2s in market, 60s after) for all 4 indices
  - In-memory cache + SQLite persistence (survives restarts)
  - On Upstox failure: keeps serving last-known-good with staleness flag
  - Exponential backoff on consecutive failures
- `/api/chain-status` diagnostic endpoint
- `server/exit-intelligence.js` — T1/T2/SL/Timeout probability + median holding time + risk:reward + recommendation
- `server/narrative-engine.js` — Plain-English signal explanation (no LLM, template-filled)
- `server/risk-engine.js` — LOW/MED/HIGH/EXTREME current risk + reasons + size recommendation
- `server/institutional-activity.js` — BULLISH/BEARISH verdict from ATM walls + OI shifts + volume spikes
- 4 new signal card blocks: 💬 AI Narrative · 🛡 Live Risk · 🚪 Exit Intelligence · 🏛 Institutional Activity

### VK avatar dropdown + AI Learning page (current commit)

- VK avatar in topbar → dropdown menu with: Ops Dashboard / AI Learning Panel / Chain Status / Health Check
- `/ai-learning.html` — dedicated page showing:
  - Training samples count + pillars learned (n/8) + overall WR + DB size
  - Per-pillar weight bars with correlation values
  - "Mean score on wins vs losses" delta table per pillar
  - Recent live trades list with P&L
  - One-click "Retrain Now" button
  - Auto-refresh every 5s

---

## Database state (D:\Projects\quantedge\data\quantedge.db)

- **125,582** historical signals (seeded backtest across 4 indices × 7 TFs × 13 strategies)
- **125,582** simulated trades from those signals
- **5+** live trades from real trading (corrected)
- ~620 MB on disk
- Factor learner trained on 27,851 joined outcomes — all 7 pillars LEARNED
- Daily backup zip in `~/QuantEdge_backups/`

---

## Local commits not pushed (8 ahead of origin/main)

```
7ec90cc  feat: Chain-Keeper + Exit Intel + Narrative + Risk + Institutional
04987cd  feat: Option Buying Intelligence Layer (P6-14) + collapsibles fix
7a37b59  fix: critical exit-pricing bug + card lock + pre-SL warning
cbef94f  week 4: AI Learning Engine + 125k mass seed + OI Flow + Equity + Cross-Index
daa5f3a  week 3: historical intelligence + MTF + backtest panel + D:\Projects move
a03adb6  week 2: parameter expansion + per-factor confidence UI + autoboot
b35603e  week 1: SQLite + ops + Windows auto-start + backups
7777112  foundation: chain snapshot + auto-exit + local persistence
```

Plus pending commit for VK dropdown + AI Learning page.

---

## Endpoints summary (D:\Projects\quantedge server)

| Endpoint | Purpose |
|---|---|
| `/` | Trading view |
| `/ops.html` | Ops dashboard |
| `/ai-learning.html` | **NEW** AI learning panel |
| `/api/health` | Server health |
| `/api/ops` | DB stats + recent signals + system logs |
| `/api/chain-status` | Per-symbol chain freshness |
| `/api/parameters/:symbol` | Live 50+ indicator snapshot |
| `/api/learner/weights` | AI-learned per-pillar weights |
| `/api/learner/retrain` (POST) | Force retrain |
| `/api/scan/all` | Cross-index parallel scan |
| `/api/equity-curve` | Cumulative P&L points |
| `/api/history/week` | All trades (live + seeded merged) |
| `/api/signals/confluence` (POST) | Full enriched signal output |
| `/api/active-trade/enter` (POST) | Enter trade (re-prices at click) |
| `/api/active-trade/exit` (POST) | Exit (server fetches chain if missing) |
| `/api/active-trade/status` (POST) | Live monitor |

---

## What every actionable signal now contains

```
.parameters         — full 50+ indicator vector
.factorScores       — per-pillar 0-100 derived score
.learnedConfidence  — weighted by AI-learned per-pillar weights
.chainSnapshot      — broker chain context (PCR, Max Pain, walls)
.chainMeta          — chain freshness + status
.similarity         — N matches + avg sim % + win rate + best/worst PnL
.mtfAlignment       — 7-TF bias grid + N/M aligned + verdict
.backtestStats      — 10y per-strategy: WR, Sharpe, profit factor, max DD
.oiFlow             — LONG_BUILDUP / SHORT_BUILDUP etc + supports flag
.expectedMove       — Conservative / Avg / Aggressive % + avg duration
.leadership         — directional leader + alignment + confirmation
.ivForecast         — expansion vs compression + premium impact
.premiumExplosion   — probability + contributors + expected magnitude
.signalQuality      — A+/A/B/C/D/F grade + failure prob + reasons
.exitIntel          — T1/T2/SL/Timeout probability + holding time
.institutional      — BULLISH/BEARISH + signals from walls/OI/volume
.liveRisk           — LOW/MED/HIGH/EXTREME + reasons + size advice
.narrative          — plain-English oneLiner + expandable markdown
```
