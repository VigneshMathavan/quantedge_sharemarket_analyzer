// server/ml/calibration-engine.js — Confidence Calibration Engine
//
// Spec:
//   "Predicted Confidence vs Actual Outcome.
//    AI said 90% → Actual success = 60% → Calibration required"
//
// What it does
// ------------
//   1. Bins predicted confidence into deciles (0-10, 10-20, ..., 90-100)
//   2. For each bin counts wins / losses from shadow_signals
//   3. Computes the **reliability diagram** (predicted vs actual per bin)
//   4. Returns aggregate **Brier score** (lower is better, perfect = 0)
//   5. Returns **Expected Calibration Error (ECE)** — weighted gap between
//      predicted and actual, used to decide if the engine should recalibrate
//
// A high ECE means the model is over- or under-confident. Downstream, the
// MetaDecisionAgent can shrink reported confidences when ECE is high.

import { db, sysLog } from '../db.js';

const NUM_BINS = 10;       // 10pp deciles

export function calibrationReport({ days = 30, regime = null } = {}) {
    const since = Date.now() - days * 86400_000;
    let rows = [];
    try {
        if (regime) {
            rows = db.prepare(`
                SELECT confidence, outcome
                  FROM shadow_signals
                 WHERE outcome IN ('WIN','LOSS')
                   AND confidence IS NOT NULL
                   AND ts >= ?
                   AND regime = ?
            `).all(since, regime);
        } else {
            rows = db.prepare(`
                SELECT confidence, outcome
                  FROM shadow_signals
                 WHERE outcome IN ('WIN','LOSS')
                   AND confidence IS NOT NULL
                   AND ts >= ?
            `).all(since);
        }
    } catch (e) {
        sysLog('WARN', 'calib', e.message);
        return { bins: [], n: 0, brier: null, ece: null, generatedAt: Date.now() };
    }

    if (!rows.length) {
        return { bins: [], n: 0, brier: null, ece: null,
                 message: 'No resolved shadows yet — calibration empty', generatedAt: Date.now() };
    }

    // Allocate bins
    const bins = Array.from({ length: NUM_BINS }, (_, i) => ({
        lo: i * (100 / NUM_BINS),
        hi: (i + 1) * (100 / NUM_BINS),
        n: 0, wins: 0, sumConf: 0
    }));

    for (const r of rows) {
        // Confidence here is the Omega score 0-100 — treat as a probability percent
        const c = Math.max(0, Math.min(99.999, r.confidence));
        const idx = Math.floor(c / (100 / NUM_BINS));
        bins[idx].n++;
        bins[idx].sumConf += c / 100;          // store as 0-1 probability
        if (r.outcome === 'WIN') bins[idx].wins++;
    }

    // Brier score: mean( (p - y)^2 )  with y in {0,1}
    let brier = 0;
    for (const r of rows) {
        const p = r.confidence / 100;
        const y = r.outcome === 'WIN' ? 1 : 0;
        brier += (p - y) ** 2;
    }
    brier /= rows.length;

    // Expected Calibration Error — weighted gap between predicted and actual
    const totalN = rows.length;
    let ece = 0;
    for (const b of bins) {
        if (b.n === 0) continue;
        const meanPred = b.sumConf / b.n;
        const actual = b.wins / b.n;
        ece += (b.n / totalN) * Math.abs(meanPred - actual);
        b.meanPredicted = parseFloat((meanPred * 100).toFixed(1));
        b.actualRate    = parseFloat((actual    * 100).toFixed(1));
        b.gap           = parseFloat(((meanPred - actual) * 100).toFixed(1));
    }

    return {
        bins,
        n: totalN,
        brier: parseFloat(brier.toFixed(4)),
        ece:   parseFloat(ece.toFixed(4)),
        // ece < 0.05 = well-calibrated; > 0.10 = poorly calibrated
        verdict: ece < 0.05 ? 'WELL_CALIBRATED'
               : ece < 0.10 ? 'ACCEPTABLE'
               : ece < 0.20 ? 'NEEDS_ATTENTION'
               : 'POORLY_CALIBRATED',
        windowDays: days,
        generatedAt: Date.now()
    };
}

/**
 * Returns the calibration multiplier the MetaDecisionAgent should apply
 * to its raw confidence — 1.0 means trust the model, < 1.0 means shrink it.
 * Derived from ECE: 1.0 - clamp(ECE, 0, 0.5).
 */
export function getCalibrationMultiplier({ days = 30, regime = null } = {}) {
    const r = calibrationReport({ days, regime });
    if (r.ece == null) return 1.0;
    return parseFloat(Math.max(0.5, 1.0 - r.ece).toFixed(3));
}

sysLog('INFO', 'calib', 'confidence calibration engine online');
