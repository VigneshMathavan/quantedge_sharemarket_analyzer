// server/ml/counterfactual-engine.js — Counterfactual Learning
//
// Spec:
//   For every decision, also score the OPPOSITE decision against the same
//   outcome. Capture "counterfactual failures":
//     • Meta said REJECT, actual outcome would have been TP3 → reject was wrong
//     • Meta said ELITE BUY, actual outcome was SL          → fire was wrong
//
// We store every counterfactual in its own table so the learner can ask:
//   "When the engine rejected setups that would have won, what features did
//    those setups share?"
//
// Schema is wide enough to reconstruct the feature snapshot, so a future
// ML training job can fit a model to predict counterfactual failures.

import crypto from 'node:crypto';
import { db, sysLog } from './../db.js';
import { bus } from './../agents/bus.js';

const insertCfStmt = db.prepare(`
    INSERT INTO counterfactual_log_v2
        (id, signal_id, symbol, side, strategy, decision, features_json, predicted_outcome, actual_outcome, predicted_pnl, actual_pnl, regret, timestamp)
    VALUES (@id, @signal_id, @symbol, @side, @strategy, @decision, @features_json, @predicted_outcome, @actual_outcome, @predicted_pnl, @actual_pnl, @regret, @timestamp)
`);

const THRESH_PCT = 0.30;

function _flipSide(side) {
    if (side === 'BUY_CALL') return 'BUY_PUT';
    if (side === 'BUY_PUT')  return 'BUY_CALL';
    return 'BUY_CALL';                          // for NO_TRADE the "what if we had fired" assumes BUY_CALL (direction-agnostic counterfactual)
}

function _outcomeForSide(side, movePct) {
    if (side === 'BUY_CALL') {
        if (movePct >=  THRESH_PCT) return 'WIN';
        if (movePct <= -THRESH_PCT) return 'LOSS';
        return 'FLAT';
    }
    if (side === 'BUY_PUT') {
        if (movePct <= -THRESH_PCT) return 'WIN';
        if (movePct >=  THRESH_PCT) return 'LOSS';
        return 'FLAT';
    }
    return Math.abs(movePct) < THRESH_PCT ? 'WIN' : 'LOSS';
}

function _label({ decidedSide, decidedBand, actualOutcome, cfOutcome }) {
    const fired = decidedBand === 'STRONG' || decidedBand === 'ELITE';
    if (fired && actualOutcome === 'WIN')  return 'CORRECT_FIRE';
    if (fired && actualOutcome === 'LOSS') return 'COUNTERFACTUAL_FIRE_FAILURE';
    // didn't fire
    if (cfOutcome === 'WIN') return 'COUNTERFACTUAL_FAILURE';      // we should have fired
    if (cfOutcome === 'LOSS') return 'CORRECT_REJECT';
    return 'NEUTRAL';
}

export function recordCounterfactual(payload) {
    try {
        const cfSide   = _flipSide(payload.decidedSide);
        const cfOutcome = _outcomeForSide(cfSide, payload.movePct ?? 0);
        const label = _label({
            decidedSide: payload.decidedSide,
            decidedBand: payload.decidedBand,
            actualOutcome: payload.actualOutcome,
            cfOutcome
        });
        
        const predicted_pnl = cfSide === 'BUY_CALL' ? (payload.movePct || 0) : -(payload.movePct || 0);
        const actual_pnl = payload.decidedSide === 'BUY_CALL' ? (payload.movePct || 0) : (payload.decidedSide === 'BUY_PUT' ? -(payload.movePct || 0) : 0);
        const regret = predicted_pnl - actual_pnl;

        insertCfStmt.run({
            id: crypto.randomUUID(),
            signal_id: payload.signalId || crypto.randomUUID(),
            symbol: payload.symbol,
            side: payload.decidedSide,
            strategy: 'META_V2',
            decision: label,
            features_json: JSON.stringify(payload.features || {}),
            predicted_outcome: cfOutcome,
            actual_outcome: payload.actualOutcome,
            predicted_pnl,
            actual_pnl,
            regret,
            timestamp: payload.ts || Date.now()
        });
        return label;
    } catch (e) {
        sysLog('WARN', 'counterfactual', e.message);
        return null;
    }
}

/** Aggregate stats — feeds the dashboard + meta decision penalty. */
export function counterfactualStats({ days = 30 } = {}) {
    const since = Date.now() - days * 86400_000;
    const rows = db.prepare(`
        SELECT decision AS cf_label,
               COUNT(*) n,
               NULL AS avg_conf,
               AVG(predicted_pnl) AS avg_move
          FROM counterfactual_log_v2
         WHERE timestamp >= ?
         GROUP BY decision
    `).all(since);
    const total = rows.reduce((s, r) => s + r.n, 0);
    return {
        total, windowDays: days,
        byLabel: rows.map(r => ({
            label: r.cf_label, n: r.n,
            avgConfidence: r.avg_conf != null ? parseFloat(r.avg_conf.toFixed(1)) : null,
            avgMovePct: r.avg_move != null ? parseFloat(r.avg_move.toFixed(2)) : null,
            share: total > 0 ? parseFloat((r.n / total * 100).toFixed(1)) : 0
        })),
        generatedAt: Date.now()
    };
}

// ─── Bus wiring — auto-record on every resolved shadow ───────────────────
bus.on('shadow:resolved', (s) => {
    if (!s?.outcome || s.outcome === 'FLAT') return;
    recordCounterfactual({
        ts: s.ts,
        symbol: s.symbol,
        signalId: s.id,
        decidedSide: s.side,
        decidedBand: s.band || (s.confidence >= 95 ? 'ELITE'
                              : s.confidence >= 90 ? 'STRONG'
                              : s.confidence >= 80 ? 'WATCHLIST'
                              : s.confidence >= 60 ? 'IGNORE' : 'REJECT'),
        confidence: s.confidence,
        actualOutcome: s.outcome,
        movePct: s.movePct,
        regime: s.regime,
        features: {}
    });
});

sysLog('INFO', 'counterfactual', 'counterfactual learning engine online');
