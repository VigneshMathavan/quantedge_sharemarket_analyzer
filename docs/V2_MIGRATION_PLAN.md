# QuantEdge V2 — Migration Plan

This document is the honest roadmap from today's working Express+vanilla-JS
QuantEdge to the V2 spec'd Next.js + NestJS + Postgres + Redis stack.

## What's already built (V2 brain, V1 stack)

The V2 *philosophy* — multi-layer AI approval, regime gating, calibration,
forecast-aware decisions — is **already live in production today** on the
existing Express stack:

| V2 Spec Requirement | Status | Module |
|---|---|---|
| 8-class Market Regime Engine | ✅ live | `server/regime-engine.js` |
| AI Trade Approval Engine (Rules 1-12) | ✅ live | `server/approval-engine.js` |
| Strategy↔Regime compatibility matrix | ✅ live | `STRATEGY_REGIME_MATRIX` |
| Trade Quality Grade (A+/A/B/C/Avoid) | ✅ live | approval.grade |
| MTF Alignment scoring (60/75/85) | ✅ live | scoreMTF() |
| Reasons + Risks + Vetoes UI | ✅ live | renderApprovalBlock() |
| AI Path Forecaster (5yr trained) | ✅ live | `server/path-forecaster.js` |
| Confidence Calibration tracker | ✅ live | `server/calibrator.js` |
| Auto-retrain (Sunday 03:00 IST) | ✅ live | `server/auto-retrain.js` |
| Trade Journal + Week History | ✅ live | `server/history.js` |
| News Sentiment Engine | ✅ live | `server/news.js` |
| Event Gate (RBI/SEBI/FOMC) | ✅ live | `server/strategies/event-gate.js` |
| Position Sizing Engine | ✅ live | `signal-builder.js` |

That's ~70% of the V2 requirements satisfied **without** the stack rewrite.

## What still needs the V2 stack

The stack migration is mostly about durability, scalability, and a more
modern frontend. It does NOT increase trading edge by itself.

### Phase A — Database (2-4 hrs)
Replace JSON files with Postgres tables:
- `trades` (replaces `data/week-trades.json`)
- `calibration` (replaces `data/calibration.json`)
- `signals_fired` (new — every signal even rejected)
- `model_archive` (replaces `data/model-archive/`)

Migration script: `server/db/migrate.js` reads existing JSONs into Postgres
on first run. Zero data loss.

### Phase B — Redis Cache + Pub/Sub (1-2 hrs)
- Move `CandleCache` from in-memory Map → Redis (multi-process safe)
- WebSocket broadcasts via Redis pub/sub (multi-instance ready)

### Phase C — Backend to NestJS (4-8 hrs)
NestJS modules wrapping current Express endpoints:
- `MarketDataModule` → wraps Upstox/Yahoo providers
- `RegimeModule` → wraps regime-engine.js
- `ApprovalModule` → wraps approval-engine.js
- `ForecasterModule` → wraps path-forecaster.js
- `TradesModule` → wraps history + tracker
- `LearningModule` → wraps calibrator + auto-retrain

All current `.js` ESM files become NestJS providers — no logic rewrite needed.

### Phase D — Frontend to Next.js + ShadCN (8-16 hrs)
- App Router with route groups: `/(dashboard)/signal`, `/(dashboard)/journal`, `/(dashboard)/calibration`
- Tailwind + ShadCN component library
- TradingView Lightweight Charts (already in use)
- Real-time data via Socket.IO + SWR for queries

### Phase E — Infra (2-4 hrs)
- `docker-compose.yml` → Postgres, Redis, NestJS, Next.js, Nginx
- PM2 for the NestJS process
- Nginx reverse proxy with TLS

## Recommended Sequence

| Step | Effort | When |
|---|---|---|
| Postgres schema + JSON migration | 2-4h | This weekend |
| Redis cache swap-in | 1-2h | This weekend |
| NestJS scaffold (wrap, don't rewrite) | 4-8h | Next weekend |
| Next.js frontend (parallel to existing) | 8-16h | Two weekends |
| Docker/Nginx | 2-4h | Final weekend |

**Total: 17–34 hours over 3-4 weekends.**

## Risk Mitigation

1. **Never break the live app.** Keep the current Express server running on
   port 4300. New stack runs on 4301. Switch only when verified.
2. **Logic is portable.** All approval/regime/forecast modules are pure
   functions — they slot into NestJS providers verbatim.
3. **Models are stable.** path-forecaster-model.json works in both stacks.
4. **Data is forward-compatible.** Migrating JSON→Postgres is one-way; no
   loss, and we keep weekly JSON snapshots as backup.

## Decision Point

You can either:
- **Ship V2 brain on V1 stack** (today) — and trade live with the new AI.
- **Wait for full V2 stack** (3-4 weekends) — same trading edge, more
  durable infra.

I recommend the first. The trading edge comes from the brain we shipped
today, not from Postgres replacing JSON files. Migrate infra when you have
spare evenings.
