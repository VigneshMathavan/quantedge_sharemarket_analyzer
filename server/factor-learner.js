// server/factor-learner.js
//
// AI LEARNING ENGINE per the master spec.
//
//   "Track every signal, every parameter, every outcome.
//    Create a parameter-performance database.
//    Continuously learn which parameters improve win rate.
//    Adjust CONFIDENCE WEIGHTS only — never modify core strategy logic."
//
// This module:
//   1. Reads completed trades from SQLite
//   2. Joins each trade with the parameter vector that fired it
//      (from signal_journal)
//   3. Per pillar (trend, vwap, volume, volatility, structure, smc,
//      priceAction, chain) computes the point-biserial correlation
//      between the pillar's score-at-signal-time and the trade outcome
//      (+1 = winner, -1 = loser)
//   4. Maps correlation [-1, +1] → weight multiplier [0.4, 1.6]
//   5. Persists the weights to the kv_store SQLite table
//   6. Final confidence = Σ (factorScore[pillar] × learnedWeight[pillar])
//      normalized to 0-100
//
// Defaults to UNIFORM WEIGHTS until ≥20 trade samples per pillar.
// Re-trains nightly + on-demand via /api/learner/retrain.

import { db, kvGet, kvSet, sysLog } from './db.js';

const PILLARS = ['trend', 'vwap', 'volume', 'volatility', 'structure', 'smc', 'priceAction', 'chain'];
const MIN_SAMPLES = 20;             // minimum trades per pillar before weight diverges from 1.0
const MAX_LOOKBACK_DAYS = 365;      // only learn from the last 12 months
const WEIGHT_KEY = 'factor_weights_v1';

// ──────────────────────────────────────────────────────────────────
//  Point-biserial correlation between a continuous variable and a
//  binary outcome (-1/+1). Returns 0 when insufficient variance.
// ──────────────────────────────────────────────────────────────────
function pointBiserial(scores, outcomes) {
    if (scores.length !== outcomes.length || scores.length < 5) return 0;
    const n = scores.length;
    const wins = outcomes.filter(o => o > 0);
    const losses = outcomes.filter(o => o < 0);
    if (wins.length === 0 || losses.length === 0) return 0;

    const winScores = scores.filter((_, i) => outcomes[i] > 0);
    const loseScores = scores.filter((_, i) => outcomes[i] < 0);
    const meanWin = winScores.reduce((a, b) => a + b, 0) / winScores.length;
    const meanLose = loseScores.reduce((a, b) => a + b, 0) / loseScores.length;
    const meanAll = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((a, b) => a + (b - meanAll) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    const p = wins.length / n;
    const q = losses.length / n;
    return ((meanWin - meanLose) / std) * Math.sqrt(p * q);
}

// ──────────────────────────────────────────────────────────────────
//  Pull trade outcomes joined with their parameter snapshots.
//  Joins by timestamp (signal_journal.ts ≈ trade.time).
// ──────────────────────────────────────────────────────────────────
function loadTrainingSet() {
    const sinceMs = Date.now() - MAX_LOOKBACK_DAYS * 86400 * 1000;
    const rows = db.prepare(`
        SELECT j.full_json AS sig_json, t.pnl
          FROM signal_journal j
          JOIN trades t ON t.time = j.ts
                       AND t.symbol = j.symbol
                       AND t.side = j.side
                       AND t.pnl IS NOT NULL
         WHERE j.ts >= ?
    `).all(sinceMs);

    const samples = [];
    for (const r of rows) {
        try {
            const sig = JSON.parse(r.sig_json);
            // Prefer the full snapshot if logged (newer journal entries)
            const factorScores = sig.actionable?.factorScores || sig.factorScores;
            if (!factorScores) continue;
            samples.push({
                outcome: r.pnl > 0 ? 1 : -1,
                factorScores
            });
        } catch { /* skip */ }
    }
    return samples;
}

// ──────────────────────────────────────────────────────────────────
//  Compute new weights from the training set. Returns object keyed
//  by pillar with {samples, winRate, correlation, weight}.
// ──────────────────────────────────────────────────────────────────
export function trainWeights() {
    const samples = loadTrainingSet();
    const weights = {};
    const wins = samples.filter(s => s.outcome > 0).length;
    const losses = samples.filter(s => s.outcome < 0).length;
    const winRate = samples.length ? wins / samples.length : 0;

    for (const pillar of PILLARS) {
        const pillarScores = [];
        const outcomes = [];
        for (const s of samples) {
            const v = s.factorScores[pillar];
            if (typeof v === 'number' && !isNaN(v)) {
                pillarScores.push(v);
                outcomes.push(s.outcome);
            }
        }
        const n = pillarScores.length;
        const corr = n >= MIN_SAMPLES ? pointBiserial(pillarScores, outcomes) : 0;
        // Map [-1, +1] correlation → [0.4, 1.6] weight multiplier
        const weight = n >= MIN_SAMPLES ? parseFloat((1 + corr * 0.6).toFixed(3)) : 1.0;

        const pillarWinScores = pillarScores.filter((_, i) => outcomes[i] > 0);
        const pillarLoseScores = pillarScores.filter((_, i) => outcomes[i] < 0);
        const meanWinScore = pillarWinScores.length
            ? pillarWinScores.reduce((a, b) => a + b, 0) / pillarWinScores.length : null;
        const meanLoseScore = pillarLoseScores.length
            ? pillarLoseScores.reduce((a, b) => a + b, 0) / pillarLoseScores.length : null;

        weights[pillar] = {
            samples: n,
            correlation: parseFloat(corr.toFixed(3)),
            weight: Math.max(0.4, Math.min(1.6, weight)),
            meanScoreOnWins: meanWinScore != null ? parseFloat(meanWinScore.toFixed(1)) : null,
            meanScoreOnLosses: meanLoseScore != null ? parseFloat(meanLoseScore.toFixed(1)) : null,
            isLearned: n >= MIN_SAMPLES
        };
    }

    const meta = {
        trainedAt: Date.now(),
        totalSamples: samples.length,
        wins, losses,
        overallWinRate: parseFloat((winRate * 100).toFixed(1)),
        weights
    };

    kvSet(WEIGHT_KEY, meta);
    sysLog('INFO', 'factor-learner',
        `trained on ${samples.length} samples · ${wins}W ${losses}L · ${parseFloat((winRate * 100).toFixed(1))}% WR`);
    return meta;
}

// ──────────────────────────────────────────────────────────────────
//  Retrieve the current learned weights (default uniform when not yet trained)
// ──────────────────────────────────────────────────────────────────
export function getCurrentWeights() {
    const stored = kvGet(WEIGHT_KEY);
    if (!stored) {
        return {
            trainedAt: null,
            totalSamples: 0,
            weights: Object.fromEntries(PILLARS.map(p => [p, { weight: 1.0, samples: 0, isLearned: false }]))
        };
    }
    return stored;
}

// ──────────────────────────────────────────────────────────────────
//  Apply learned weights to a raw factorScores object → final
//  weighted confidence 0-100. Used by the confluence endpoint to
//  produce the "learnedConfidence" output alongside the raw score.
// ──────────────────────────────────────────────────────────────────
export function applyLearnedWeights(factorScores) {
    if (!factorScores) return null;
    const { weights } = getCurrentWeights();
    let totalWeight = 0;
    let weightedSum = 0;
    const breakdown = {};
    for (const [pillar, score] of Object.entries(factorScores)) {
        const w = weights[pillar]?.weight ?? 1.0;
        const contribution = score * w;
        weightedSum += contribution;
        totalWeight += w;
        breakdown[pillar] = {
            rawScore: parseFloat(score.toFixed(1)),
            weight: w,
            contribution: parseFloat(contribution.toFixed(1))
        };
    }
    const final = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return {
        weightedConfidence: parseFloat(final.toFixed(1)),
        breakdown
    };
}

// ──────────────────────────────────────────────────────────────────
//  Schedule nightly retrain at 23:30 IST (after backup)
// ──────────────────────────────────────────────────────────────────
let _lastRetrainDate = null;
setInterval(() => {
    const istMs = Date.now() + (5 * 60 + 30) * 60000;
    const ist = new Date(istMs);
    const h = ist.getUTCHours(), m = ist.getUTCMinutes();
    const date = ist.toISOString().slice(0, 10);
    if (h === 23 && m === 30 && _lastRetrainDate !== date) {
        _lastRetrainDate = date;
        try {
            trainWeights();
        } catch (e) { sysLog('ERROR', 'factor-learner', 'nightly retrain failed: ' + e.message); }
    }
}, 60 * 1000);
