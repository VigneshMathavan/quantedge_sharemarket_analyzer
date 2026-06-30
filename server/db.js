// server/db.js — SQLite persistence layer.
//
// Replaces the ephemeral JSON file storage (which died on every Railway
// redeploy) with a real local database. Schema is forward-compatible
// with the planned Supabase migration — same column names + JSON
// payload columns for safe extensibility.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'quantedge.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');         // concurrent reads, durable writes
db.pragma('synchronous = NORMAL');       // safe + fast on local SSD
db.pragma('foreign_keys = ON');

// ──────────────────────────────────────────────────────────────────
//  SCHEMA — initialized on every boot, idempotent
// ──────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS trades (
    id              TEXT PRIMARY KEY,
    time            INTEGER NOT NULL,
    exit_time       INTEGER,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    strike          REAL,
    right           TEXT,
    entry_premium   REAL,
    exit_premium    REAL,
    sl_premium      REAL,
    t1_premium      REAL,
    t2_premium      REAL,
    spot_entry      REAL,
    spot_exit       REAL,
    lots            INTEGER,
    lot_size        INTEGER,
    quantity        INTEGER,
    pnl             REAL,
    pnl_pct         REAL,
    result          TEXT,
    exit_reason     TEXT,
    tier            TEXT,
    confidence      REAL,
    regime          TEXT,
    firing_strategies TEXT,
    chain_snapshot  TEXT,
    full_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(time);
CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

CREATE TABLE IF NOT EXISTS signal_journal (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    symbol            TEXT NOT NULL,
    side              TEXT,
    tier              TEXT,
    confluence_score  REAL,
    approval_score    REAL,
    approval_grade    TEXT,
    regime            TEXT,
    forecast_verdict  TEXT,
    forecast_pt1      REAL,
    forecast_psl      REAL,
    firing_count      INTEGER,
    strike            REAL,
    option_right      TEXT,
    premium           REAL,
    chain_pcr         REAL,
    chain_max_pain    REAL,
    chain_atm         REAL,
    spot              REAL,
    full_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_ts ON signal_journal(ts);
CREATE INDEX IF NOT EXISTS idx_journal_symbol ON signal_journal(symbol);
CREATE INDEX IF NOT EXISTS idx_journal_setup ON signal_journal(symbol, side, tier);

CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_log (
    ts        INTEGER NOT NULL,
    level     TEXT,
    component TEXT,
    message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_syslog_ts ON system_log(ts);

-- Omega "learn from everything" — every potential setup, regardless of score.
-- Populated by observer.js on a fixed cadence for all 4 indices.
-- Resolved (outcome filled in) 30 min after creation by the resolver loop.
CREATE TABLE IF NOT EXISTS shadow_signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT,                -- BUY_CALL / BUY_PUT / NO_TRADE
    confidence      REAL,                -- 0-100
    band            TEXT,                -- REJECT/IGNORE/WATCHLIST/STRONG/ELITE
    spot            REAL,
    regime          TEXT,
    conditions_json TEXT,                -- compact pillar breakdown
    factor_scores_json TEXT,             -- {trend, vwap, volume, ...}
    fired           INTEGER DEFAULT 0,   -- 1 if surfaced to UI (STRONG/ELITE)
    resolved_at     INTEGER,             -- ts when outcome was scored
    resolved_spot   REAL,                -- spot price 30 min later
    move_pct        REAL,                -- signed % spot move
    outcome         TEXT                 -- WIN / LOSS / FLAT (null until resolved)
);
CREATE INDEX IF NOT EXISTS idx_shadow_ts ON shadow_signals(ts);
CREATE INDEX IF NOT EXISTS idx_shadow_symbol_band ON shadow_signals(symbol, band, ts);
CREATE INDEX IF NOT EXISTS idx_shadow_unresolved ON shadow_signals(resolved_at, ts);
CREATE INDEX IF NOT EXISTS idx_shadow_outcome ON shadow_signals(outcome, band);

-- Phase 1: Decision audit trail (comprehensive)
CREATE TABLE IF NOT EXISTS decision_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT,
    signal_id TEXT,
    ts INTEGER NOT NULL,
    symbol TEXT,
    side TEXT,
    band TEXT,
    omega REAL,
    calibrated_score REAL,
    fireable INTEGER,
    regime TEXT,
    regime_confidence REAL,
    agent_votes_json TEXT,
    bayesian_prob REAL,
    ml_prediction REAL,
    meta_weights_json TEXT,
    factor_scores_json TEXT,
    risk_level TEXT,
    risk_reasons_json TEXT,
    decision TEXT,
    decision_reasons_json TEXT,
    evidence_json TEXT,
    expected_value REAL,
    expected_rr REAL,
    outcome TEXT,
    pnl REAL,
    exit_reason TEXT,
    outcome_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_da_ts ON decision_audit(ts);
CREATE INDEX IF NOT EXISTS idx_da_trace ON decision_audit(trace_id);
CREATE INDEX IF NOT EXISTS idx_da_symbol ON decision_audit(symbol, ts);

-- Phase 1: Agent performance tracking (per-regime)
CREATE TABLE IF NOT EXISTS agent_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    regime TEXT,
    period TEXT,
    precision_val REAL,
    recall_val REAL,
    f1 REAL,
    accuracy REAL,
    false_positive_rate REAL,
    sharpe_contribution REAL,
    ev_contribution REAL,
    sample_count INTEGER,
    timestamp INTEGER DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_ap_agent ON agent_performance(agent_name, regime);

-- Phase 1: Counterfactual log (expanded from KV)
CREATE TABLE IF NOT EXISTS counterfactual_log_v2 (
    id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL,
    symbol TEXT,
    side TEXT,
    strategy TEXT,
    decision TEXT NOT NULL,
    features_json TEXT,
    predicted_outcome TEXT,
    actual_outcome TEXT,
    predicted_pnl REAL,
    actual_pnl REAL,
    regret REAL,
    timestamp INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cf2_decision ON counterfactual_log_v2(decision);
CREATE INDEX IF NOT EXISTS idx_cf2_ts ON counterfactual_log_v2(timestamp);
`);

// Phase 9 — add MFE/MAE/RRR columns to shadow_signals if not present (idempotent ALTERs)
try { db.exec("ALTER TABLE shadow_signals ADD COLUMN mfe_pct REAL"); } catch {}
try { db.exec("ALTER TABLE shadow_signals ADD COLUMN mae_pct REAL"); } catch {}
try { db.exec("ALTER TABLE shadow_signals ADD COLUMN rrr REAL"); } catch {}
try { db.exec("ALTER TABLE shadow_signals ADD COLUMN bars_to_outcome INTEGER"); } catch {}

// Migration: add 'source' column on existing trades tables (was added later).
try { db.exec("ALTER TABLE trades ADD COLUMN source TEXT DEFAULT 'live'"); } catch {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source)'); } catch {}

console.log(`[db] SQLite initialized at ${DB_PATH}`);

// ──────────────────────────────────────────────────────────────────
//  TRADE API
// ──────────────────────────────────────────────────────────────────
const insertTradeStmt = db.prepare(`
    INSERT OR REPLACE INTO trades (
        id, time, exit_time, symbol, side, strike, right,
        entry_premium, exit_premium, sl_premium, t1_premium, t2_premium,
        spot_entry, spot_exit, lots, lot_size, quantity,
        pnl, pnl_pct, result, exit_reason, tier, confidence, regime,
        firing_strategies, chain_snapshot, full_json, source
    ) VALUES (
        @id, @time, @exit_time, @symbol, @side, @strike, @right,
        @entry_premium, @exit_premium, @sl_premium, @t1_premium, @t2_premium,
        @spot_entry, @spot_exit, @lots, @lot_size, @quantity,
        @pnl, @pnl_pct, @result, @exit_reason, @tier, @confidence, @regime,
        @firing_strategies, @chain_snapshot, @full_json, @source
    )
`);

export function saveTrade(t) {
    const row = {
        id: t.id || `t_${t.time || Date.now()}`,
        time: t.time || Date.now(),
        exit_time: t.exitTime || null,
        symbol: t.symbol || null,
        side: t.side || null,
        strike: t.strike || t.option?.strike || null,
        right: t.right || t.option?.right || null,
        entry_premium: t.entry ?? t.option?.premium ?? null,
        exit_premium: t.exit ?? null,
        sl_premium: t.option?.premiumSL ?? null,
        t1_premium: t.option?.premiumT1 ?? null,
        t2_premium: t.option?.premiumT2 ?? null,
        spot_entry: t.spot?.entry ?? null,
        spot_exit: t.spotExit ?? null,
        lots: t.sizing?.lots ?? null,
        lot_size: t.option?.lotSize ?? null,
        quantity: t.qty ?? t.sizing?.quantity ?? null,
        pnl: t.pnl ?? 0,
        pnl_pct: t.pnlPct ?? null,
        result: t.result || (t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'FLAT'),
        exit_reason: t.exitReason || null,
        tier: t.tier || t.potentialTier || null,
        confidence: t.confidence ?? t.confluenceScore ?? null,
        regime: t.regime || null,
        firing_strategies: JSON.stringify(t.firingStrategies || []),
        chain_snapshot: JSON.stringify(t.chainSnapshot || null),
        full_json: JSON.stringify(t),
        source: t.source || 'live'
    };
    try {
        insertTradeStmt.run(row);
        return true;
    } catch (e) {
        console.error('[db] saveTrade failed:', e.message);
        return false;
    }
}

const allTradesStmt = db.prepare('SELECT * FROM trades ORDER BY time ASC');
const tradesSinceStmt = db.prepare('SELECT * FROM trades WHERE time >= ? ORDER BY time ASC');

export function listTrades({ since = null } = {}) {
    const rows = since ? tradesSinceStmt.all(since) : allTradesStmt.all();
    return rows.map(r => {
        try {
            const full = JSON.parse(r.full_json || '{}');
            return { ...full, ...denormalizeTrade(r) };
        } catch {
            return denormalizeTrade(r);
        }
    });
}

function denormalizeTrade(r) {
    return {
        id: r.id, time: r.time, exitTime: r.exit_time,
        symbol: r.symbol, side: r.side,
        strike: r.strike, right: r.right,
        entry: r.entry_premium, exit: r.exit_premium,
        pnl: r.pnl, pnlPct: r.pnl_pct, result: r.result,
        exitReason: r.exit_reason, tier: r.tier,
        confidence: r.confidence, regime: r.regime
    };
}

const pruneTradesStmt = db.prepare('DELETE FROM trades WHERE COALESCE(exit_time, time) < ?');
export function pruneTradesOlderThan(cutoffMs) {
    return pruneTradesStmt.run(cutoffMs).changes;
}

// ──────────────────────────────────────────────────────────────────
//  SIGNAL JOURNAL API
// ──────────────────────────────────────────────────────────────────
const insertJournalStmt = db.prepare(`
    INSERT INTO signal_journal (
        ts, symbol, side, tier, confluence_score, approval_score, approval_grade,
        regime, forecast_verdict, forecast_pt1, forecast_psl, firing_count,
        strike, option_right, premium, chain_pcr, chain_max_pain, chain_atm, spot, full_json
    ) VALUES (
        @ts, @symbol, @side, @tier, @confluence_score, @approval_score, @approval_grade,
        @regime, @forecast_verdict, @forecast_pt1, @forecast_psl, @firing_count,
        @strike, @option_right, @premium, @chain_pcr, @chain_max_pain, @chain_atm, @spot, @full_json
    )
`);

export function logSignal(record) {
    const row = {
        ts: record.ts || Date.now(),
        symbol: record.symbol || null,
        side: record.side || null,
        tier: record.tier || null,
        confluence_score: record.confluenceScore ?? null,
        approval_score: record.approvalScore ?? null,
        approval_grade: record.approvalGrade ?? null,
        regime: record.regime || null,
        forecast_verdict: record.forecast?.verdict ?? null,
        forecast_pt1: record.forecast?.pT1 ?? null,
        forecast_psl: record.forecast?.pSL ?? null,
        firing_count: (record.firingStrategies || []).length,
        strike: record.actionable?.strike ?? null,
        option_right: record.actionable?.right ?? null,
        premium: record.actionable?.premium ?? null,
        chain_pcr: record.chainContext?.pcr ?? null,
        chain_max_pain: record.chainContext?.maxPain ?? null,
        chain_atm: record.chainContext?.atm ?? null,
        spot: record.priceContext?.close ?? null,
        full_json: JSON.stringify(record)
    };
    try {
        insertJournalStmt.run(row);
        return true;
    } catch (e) {
        console.error('[db] logSignal failed:', e.message);
        return false;
    }
}

const recentJournalStmt = db.prepare('SELECT * FROM signal_journal ORDER BY ts DESC LIMIT ?');
const journalSinceStmt = db.prepare('SELECT * FROM signal_journal WHERE ts >= ? ORDER BY ts ASC');

export function recentSignals(limit = 200) {
    return recentJournalStmt.all(limit).map(parseJournal);
}
export function journalSince(sinceMs) {
    return journalSinceStmt.all(sinceMs).map(parseJournal);
}
function parseJournal(r) {
    try {
        const full = JSON.parse(r.full_json || '{}');
        return { ...r, full };
    } catch { return r; }
}

// ──────────────────────────────────────────────────────────────────
//  KEY-VALUE store — for win-prob model, settings, etc.
// ──────────────────────────────────────────────────────────────────
const kvGetStmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
const kvSetStmt = db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
export function kvGet(key) {
    const row = kvGetStmt.get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
}
export function kvSet(key, value) {
    kvSetStmt.run(key, JSON.stringify(value), Date.now());
}

// ──────────────────────────────────────────────────────────────────
//  SYSTEM LOG
// ──────────────────────────────────────────────────────────────────
const insertLogStmt = db.prepare('INSERT INTO system_log (ts, level, component, message) VALUES (?, ?, ?, ?)');
const pruneLogsStmt = db.prepare('DELETE FROM system_log WHERE ts < ?');
const recentLogsStmt = db.prepare('SELECT * FROM system_log ORDER BY ts DESC LIMIT ?');

export function sysLog(level, component, message) {
    try { insertLogStmt.run(Date.now(), level, component, message); } catch {}
}
export function recentLogs(limit = 100) {
    return recentLogsStmt.all(limit);
}
// Prune logs older than 7 days every hour
setInterval(() => {
    try {
        const cutoff = Date.now() - 7 * 86400 * 1000;
        pruneLogsStmt.run(cutoff);
    } catch {}
}, 3600 * 1000);

// ──────────────────────────────────────────────────────────────────
//  SHADOW SIGNALS — Omega "learn from everything"
//  Every potential setup, every cadence tick, regardless of score.
//  Resolved 30 min later by the observer's resolver loop.
// ──────────────────────────────────────────────────────────────────
const insertShadowStmt = db.prepare(`
    INSERT INTO shadow_signals
        (ts, symbol, side, confidence, band, spot, regime,
         conditions_json, factor_scores_json, fired)
    VALUES
        (@ts, @symbol, @side, @confidence, @band, @spot, @regime,
         @conditions_json, @factor_scores_json, @fired)
`);
const resolveShadowStmt = db.prepare(`
    UPDATE shadow_signals
       SET resolved_at = ?, resolved_spot = ?, move_pct = ?, outcome = ?,
           mfe_pct = ?, mae_pct = ?, rrr = ?, bars_to_outcome = ?
     WHERE id = ?
`);
const unresolvedShadowStmt = db.prepare(`
    SELECT id, ts, symbol, side, spot
      FROM shadow_signals
     WHERE resolved_at IS NULL
       AND ts <= ?
     ORDER BY ts ASC
     LIMIT ?
`);
const recentShadowStmt = db.prepare(`
    SELECT * FROM shadow_signals
     ORDER BY ts DESC
     LIMIT ?
`);
const shadowStatsByBandStmt = db.prepare(`
    SELECT band,
           COUNT(*) total,
           SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) losses,
           SUM(CASE WHEN outcome = 'FLAT' THEN 1 ELSE 0 END) flats,
           SUM(CASE WHEN outcome IS NULL  THEN 1 ELSE 0 END) pending,
           AVG(confidence) avg_conf
      FROM shadow_signals
     WHERE ts >= ?
     GROUP BY band
     ORDER BY avg_conf DESC
`);

export function saveShadowSignal(s) {
    try {
        const info = insertShadowStmt.run({
            ts:         s.ts || Date.now(),
            symbol:     s.symbol,
            side:       s.side || 'NO_TRADE',
            confidence: s.confidence ?? 0,
            band:       s.band || 'REJECT',
            spot:       s.spot ?? null,
            regime:     s.regime || null,
            conditions_json:    JSON.stringify(s.conditions || {}),
            factor_scores_json: JSON.stringify(s.factorScores || {}),
            fired:      s.fired ? 1 : 0
        });
        return info.lastInsertRowid;
    } catch (e) {
        sysLog('ERROR', 'shadow', 'insert failed: ' + e.message);
        return null;
    }
}

/**
 * Resolve a shadow signal with full outcome metrics.
 *
 * If `forwardPath` is supplied (array of forward candles between entry ts and
 * resolution ts), we compute:
 *    move_pct        — end-to-end signed return
 *    mfe_pct         — max favorable excursion (peak gain along the path)
 *    mae_pct         — max adverse excursion (worst drawdown along the path)
 *    rrr             — realized R-multiple = mfe / |mae|
 *    bars_to_outcome — bar index where outcome was first triggered
 *
 * If no path is supplied (legacy callers / cold restart), we degrade to the
 * simple end-to-end ±0.3% labeling so nothing breaks.
 */
export function resolveShadowSignal(id, resolvedSpot, side, originalSpot, forwardPath = null) {
    if (!Number.isFinite(resolvedSpot) || !Number.isFinite(originalSpot) || originalSpot <= 0) return;
    const movePct = ((resolvedSpot - originalSpot) / originalSpot) * 100;
    const THRESH = 0.30;

    // ── Path-based metrics (when available) ─────────────────────────────
    let mfePct = null, maePct = null, rrr = null, barsToOutcome = null;
    if (Array.isArray(forwardPath) && forwardPath.length) {
        let maxFav = 0, maxAdv = 0;
        let triggerBar = forwardPath.length;
        for (let i = 0; i < forwardPath.length; i++) {
            const c = forwardPath[i];
            const high = c.high ?? c.close;
            const low  = c.low  ?? c.close;
            const upPct   = ((high - originalSpot) / originalSpot) * 100;
            const downPct = ((low  - originalSpot) / originalSpot) * 100;
            const fav = side === 'BUY_PUT' ? -downPct : upPct;
            const adv = side === 'BUY_PUT' ? -upPct   : downPct;
            if (fav > maxFav) maxFav = fav;
            if (adv < maxAdv) maxAdv = adv;
            if (triggerBar === forwardPath.length &&
                (Math.abs(fav) >= THRESH || Math.abs(adv) >= THRESH)) {
                triggerBar = i;
            }
        }
        mfePct = parseFloat(maxFav.toFixed(3));
        maePct = parseFloat(maxAdv.toFixed(3));
        rrr = maePct < 0 ? parseFloat((mfePct / Math.abs(maePct)).toFixed(2)) : null;
        barsToOutcome = triggerBar;
    }

    // ── Outcome label (direction-aware, threshold = 0.30%) ─────────────
    let outcome = 'FLAT';
    if (side === 'BUY_CALL') {
        if (movePct >=  THRESH) outcome = 'WIN';
        else if (movePct <= -THRESH) outcome = 'LOSS';
    } else if (side === 'BUY_PUT') {
        if (movePct <= -THRESH) outcome = 'WIN';
        else if (movePct >=  THRESH) outcome = 'LOSS';
    } else {
        outcome = Math.abs(movePct) < THRESH ? 'WIN' : 'LOSS';
    }

    try {
        resolveShadowStmt.run(
            Date.now(), resolvedSpot, parseFloat(movePct.toFixed(3)), outcome,
            mfePct, maePct, rrr, barsToOutcome,
            id
        );
    } catch (e) {
        sysLog('ERROR', 'shadow', 'resolve failed: ' + e.message);
    }
}

export function getUnresolvedShadowSignals(olderThanMs, limit = 200) {
    return unresolvedShadowStmt.all(olderThanMs, limit);
}

export function getRecentShadowSignals(limit = 100) {
    return recentShadowStmt.all(limit);
}

export function getShadowStatsByBand(sinceMs) {
    return shadowStatsByBandStmt.all(sinceMs || (Date.now() - 7 * 86400 * 1000));
}

// ──────────────────────────────────────────────────────────────────
//  STATS — for ops dashboard
// ──────────────────────────────────────────────────────────────────
export function getDbStats() {
    return {
        tradeCount: db.prepare('SELECT COUNT(*) c FROM trades').get().c,
        signalCount: db.prepare('SELECT COUNT(*) c FROM signal_journal').get().c,
        shadowCount: db.prepare('SELECT COUNT(*) c FROM shadow_signals').get().c,
        shadowResolved: db.prepare('SELECT COUNT(*) c FROM shadow_signals WHERE outcome IS NOT NULL').get().c,
        logCount: db.prepare('SELECT COUNT(*) c FROM system_log').get().c,
        dbPath: DB_PATH,
        dbSizeMB: (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2),
        lastTrade: db.prepare('SELECT MAX(time) t FROM trades').get().t,
        lastSignal: db.prepare('SELECT MAX(ts) t FROM signal_journal').get().t
    };
}
