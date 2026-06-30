// server/ml/confusion-matrix.js — Classification metrics
//
// Spec:
//   "Tracks: True Positive · True Negative · False Positive · False Negative"
//
// Definition for QuantEdge:
//   POSITIVE prediction = band ∈ {STRONG, ELITE}   (system says "trade this")
//   NEGATIVE prediction = band ∈ {REJECT, IGNORE, WATCHLIST}
//   POSITIVE outcome    = WIN
//   NEGATIVE outcome    = LOSS
//
//   TP = (STRONG|ELITE) and WIN          — we said trade, it worked
//   FP = (STRONG|ELITE) and LOSS         — we said trade, it failed
//   TN = (REJECT|IGNORE|WATCHLIST) and LOSS — we skipped, would have lost ✓
//   FN = (REJECT|IGNORE|WATCHLIST) and WIN  — we skipped, would have won ✗

import { db, sysLog } from '../db.js';

function _isFireable(band) { return band === 'STRONG' || band === 'ELITE'; }

export function confusionMatrix({ days = 30, symbol = null } = {}) {
    const since = Date.now() - days * 86400_000;
    let rows = [];
    try {
        const q = symbol
            ? `SELECT band, outcome FROM shadow_signals
                WHERE outcome IN ('WIN','LOSS') AND symbol = ? AND ts >= ?`
            : `SELECT band, outcome FROM shadow_signals
                WHERE outcome IN ('WIN','LOSS') AND ts >= ?`;
        rows = symbol
            ? db.prepare(q).all(symbol, since)
            : db.prepare(q).all(since);
    } catch (e) {
        sysLog('WARN', 'confusion', e.message);
    }

    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of rows) {
        const pos = _isFireable(r.band);
        const win = r.outcome === 'WIN';
        if (pos && win) tp++;
        else if (pos && !win) fp++;
        else if (!pos && !win) tn++;
        else fn++;
    }

    const n = tp + fp + tn + fn;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
    const recall    = (tp + fn) > 0 ? tp / (tp + fn) : null;
    const specificity = (tn + fp) > 0 ? tn / (tn + fp) : null;
    const f1 = (precision && recall && (precision + recall) > 0)
        ? 2 * precision * recall / (precision + recall) : null;
    const accuracy = n > 0 ? (tp + tn) / n : null;
    const fpr = (fp + tn) > 0 ? fp / (fp + tn) : null;
    const fnr = (fn + tp) > 0 ? fn / (fn + tp) : null;

    return {
        n, tp, fp, tn, fn,
        precision: precision != null ? parseFloat(precision.toFixed(3)) : null,
        recall:    recall    != null ? parseFloat(recall.toFixed(3))    : null,
        specificity: specificity != null ? parseFloat(specificity.toFixed(3)) : null,
        f1:        f1        != null ? parseFloat(f1.toFixed(3))        : null,
        accuracy:  accuracy  != null ? parseFloat(accuracy.toFixed(3))  : null,
        falsePositiveRate: fpr != null ? parseFloat(fpr.toFixed(3)) : null,
        falseNegativeRate: fnr != null ? parseFloat(fnr.toFixed(3)) : null,
        symbol, windowDays: days, generatedAt: Date.now()
    };
}

export function evaluateAgentPerformance({ days = 30 } = {}) {
    const since = Date.now() - days * 86400_000;
    let rows = [];
    try {
        const q = `SELECT ts, outcome, regime, agent_votes_json FROM decision_audit WHERE outcome IN ('WIN','LOSS') AND ts >= ?`;
        rows = db.prepare(q).all(since);
    } catch (e) {
        sysLog('WARN', 'agent_performance', e.message);
        return;
    }

    const stats = {};

    for (const r of rows) {
        const win = r.outcome === 'WIN';
        if (!r.agent_votes_json) continue;
        
        let votes = [];
        try {
            votes = JSON.parse(r.agent_votes_json);
        } catch (e) {
            continue;
        }
        if (!Array.isArray(votes)) continue;

        const regime = r.regime || 'UNKNOWN';

        for (const v of votes) {
            const agent = v.agent;
            if (!agent) continue;
            
            const key = `${agent}|${regime}`;
            if (!stats[key]) {
                stats[key] = { tp: 0, fp: 0, tn: 0, fn: 0, count: 0, agent, regime };
            }

            const s = stats[key];
            const traded = v.side === 'BUY_CALL' || v.side === 'BUY_PUT';

            if (traded && win) s.tp++;
            else if (traded && !win) s.fp++;
            else if (!traded && !win) s.tn++;
            else if (!traded && win) s.fn++;

            s.count++;
        }
    }

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO agent_performance (
            agent_name, regime, period, precision_val, recall_val, f1,
            accuracy, false_positive_rate, sharpe_contribution, ev_contribution,
            sample_count, timestamp
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `);

    const periodStr = `${days}d`;
    const now = Date.now();

    try {
        const insertTx = db.transaction(() => {
            for (const s of Object.values(stats)) {
                const { tp, fp, tn, fn, count, agent, regime } = s;
                const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
                const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
                const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
                    ? (2 * precision * recall) / (precision + recall)
                    : null;
                const accuracy = count > 0 ? (tp + tn) / count : null;
                const fpr = (fp + tn) > 0 ? fp / (fp + tn) : null;

                const ev_contribution = tp * 1.5 - fp * 1.0;
                const sharpe_contribution = null;

                stmt.run(
                    agent, regime, periodStr,
                    precision, recall, f1, accuracy, fpr,
                    sharpe_contribution, ev_contribution, count, now
                );
            }
        });
        insertTx();
    } catch (e) {
        sysLog('WARN', 'agent_performance_insert', e.message);
    }
}

setInterval(() => {
    try { evaluateAgentPerformance(); } catch(e){}
}, 24 * 3600 * 1000);

sysLog('INFO', 'confusion', 'confusion-matrix tracker online');
