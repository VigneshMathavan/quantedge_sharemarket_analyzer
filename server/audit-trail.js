// server/audit-trail.js — immutable Meta-decision audit log
import { db, sysLog } from './db.js';
import { bus } from './agents/bus.js';

db.exec(`
CREATE TABLE IF NOT EXISTS audit_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    symbol TEXT, side TEXT, band TEXT, omega REAL,
    fireable INTEGER, calibrated REAL, regime TEXT,
    votes_json TEXT, evidence_json TEXT, explanation TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_trail(ts);
CREATE INDEX IF NOT EXISTS idx_audit_symbol ON audit_trail(symbol, ts);
`);

// ── Phase 1 Decision Audit Trail (new table, old one untouched) ──
db.exec(`
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
    -- Decision inputs
    agent_votes_json TEXT,
    bayesian_prob REAL,
    ml_prediction REAL,
    meta_weights_json TEXT,
    factor_scores_json TEXT,
    risk_level TEXT,
    risk_reasons_json TEXT,
    -- Decision output
    decision TEXT,
    decision_reasons_json TEXT,
    evidence_json TEXT,
    -- EV intelligence
    expected_value REAL,
    expected_rr REAL,
    -- Outcome (filled later)
    outcome TEXT,
    pnl REAL,
    exit_reason TEXT,
    outcome_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_da_ts ON decision_audit(ts);
CREATE INDEX IF NOT EXISTS idx_da_trace ON decision_audit(trace_id);
CREATE INDEX IF NOT EXISTS idx_da_symbol ON decision_audit(symbol, ts);
`);

// ── Legacy audit_trail insert (backward-compatible bus listener) ──
const insert = db.prepare(`
    INSERT INTO audit_trail (ts, symbol, side, band, omega, fireable, calibrated, regime, votes_json, evidence_json, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

bus.on('meta:decision', (d) => {
    try {
        insert.run(
            Date.now(), d.symbol, d.side, d.band, d.omegaScore || 0,
            d.fireable ? 1 : 0, d.calibratedScore || null, d.regime || null,
            JSON.stringify(d.votes || []).slice(0, 6000),
            JSON.stringify(d.evidence || []).slice(0, 4000),
            d.reasoning || null
        );
    } catch (e) { sysLog('WARN', 'audit', e.message); }
});

// ── decision_audit insert ──
const insertDecision = db.prepare(`
    INSERT INTO decision_audit (
        trace_id, signal_id, ts, symbol, side, band, omega,
        calibrated_score, fireable, regime, regime_confidence,
        agent_votes_json, bayesian_prob, ml_prediction,
        meta_weights_json, factor_scores_json,
        risk_level, risk_reasons_json,
        decision, decision_reasons_json, evidence_json,
        expected_value, expected_rr
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?
    )
`);

/**
 * Record a full decision audit entry from MetaDecisionAgent.
 * Called after each meta-decision is built.
 */
export function recordDecision(d) {
    try {
        const di = d.decisionIntelligence || {};
        insertDecision.run(
            d.traceId || null,
            d.signalId || null,
            Date.now(),
            d.symbol || null,
            d.side || null,
            d.band || null,
            d.omegaScore ?? null,
            d.calibratedScore ?? null,
            d.fireable ? 1 : 0,
            d.regime || null,
            d.regimeConfidence ?? null,
            JSON.stringify(d.votes || []).slice(0, 8000),
            di.pWin ?? null,
            d.mlPrediction ?? null,
            d.adaptiveWeights ? JSON.stringify(d.adaptiveWeights).slice(0, 4000) : null,
            d.factorScores ? JSON.stringify(d.factorScores).slice(0, 4000) : null,
            d.riskLevel || null,
            d.riskReasons ? JSON.stringify(d.riskReasons).slice(0, 4000) : null,
            d.side || null,
            d.reasoning ? JSON.stringify(d.reasoning).slice(0, 4000) : null,
            JSON.stringify(d.evidence || []).slice(0, 6000),
            di.expectedValuePct ?? null,
            di.expectedRR ?? null
        );
    } catch (e) {
        sysLog('WARN', 'audit', `recordDecision failed: ${e.message}`);
    }
}

/**
 * Backfill outcome data for a previously recorded decision.
 */
export function updateOutcome(traceId, { outcome, pnl, exitReason } = {}) {
    try {
        db.prepare(`
            UPDATE decision_audit
               SET outcome = ?, pnl = ?, exit_reason = ?, outcome_time = ?
             WHERE trace_id = ?
        `).run(outcome || null, pnl ?? null, exitReason || null, Date.now(), traceId);
    } catch (e) {
        sysLog('WARN', 'audit', `updateOutcome failed: ${e.message}`);
    }
}

/**
 * Query decision audit entries for API consumption.
 */
export function queryDecisions({ symbol = null, days = 7, limit = 200 } = {}) {
    const since = Date.now() - days * 86400_000;
    if (symbol) {
        return db.prepare(
            `SELECT * FROM decision_audit WHERE symbol = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
        ).all(symbol, since, limit);
    }
    return db.prepare(
        `SELECT * FROM decision_audit WHERE ts >= ? ORDER BY ts DESC LIMIT ?`
    ).all(since, limit);
}

/**
 * Query losing decisions for review / post-mortem.
 */
export function queryLosses({ days = 30, limit = 100 } = {}) {
    const since = Date.now() - days * 86400_000;
    return db.prepare(
        `SELECT * FROM decision_audit WHERE outcome = 'LOSS' AND ts >= ? ORDER BY ts DESC LIMIT ?`
    ).all(since, limit);
}

// ── Legacy exports (backward-compatible) ──
export function auditQuery({ symbol = null, days = 7, limit = 200 } = {}) {
    const since = Date.now() - days * 86400_000;
    const q = symbol
        ? `SELECT * FROM audit_trail WHERE symbol = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
        : `SELECT * FROM audit_trail WHERE ts >= ? ORDER BY ts DESC LIMIT ?`;
    return symbol ? db.prepare(q).all(symbol, since, limit) : db.prepare(q).all(since, limit);
}
export function auditCount({ days = 30 } = {}) {
    const since = Date.now() - days * 86400_000;
    return db.prepare(`SELECT COUNT(*) c FROM audit_trail WHERE ts >= ?`).get(since).c;
}

sysLog('INFO', 'audit', 'audit trail online (v2 — decision_audit table ready)');
