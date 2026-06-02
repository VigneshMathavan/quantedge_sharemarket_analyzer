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
`);

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
        firing_strategies, chain_snapshot, full_json
    ) VALUES (
        @id, @time, @exit_time, @symbol, @side, @strike, @right,
        @entry_premium, @exit_premium, @sl_premium, @t1_premium, @t2_premium,
        @spot_entry, @spot_exit, @lots, @lot_size, @quantity,
        @pnl, @pnl_pct, @result, @exit_reason, @tier, @confidence, @regime,
        @firing_strategies, @chain_snapshot, @full_json
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
        full_json: JSON.stringify(t)
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
//  STATS — for ops dashboard
// ──────────────────────────────────────────────────────────────────
export function getDbStats() {
    return {
        tradeCount: db.prepare('SELECT COUNT(*) c FROM trades').get().c,
        signalCount: db.prepare('SELECT COUNT(*) c FROM signal_journal').get().c,
        logCount: db.prepare('SELECT COUNT(*) c FROM system_log').get().c,
        dbPath: DB_PATH,
        dbSizeMB: (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2),
        lastTrade: db.prepare('SELECT MAX(time) t FROM trades').get().t,
        lastSignal: db.prepare('SELECT MAX(ts) t FROM signal_journal').get().t
    };
}
