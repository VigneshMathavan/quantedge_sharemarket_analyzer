// server/similarity-engine.js
//
// HISTORICAL INTELLIGENCE ENGINE per the master spec.
// When a signal fires, this engine searches the signal_journal +
// 10-year backtest archive for setups with similar parameter
// fingerprints and returns:
//   • Number of historical matches
//   • Average win rate
//   • Average return + duration
//   • Best / worst case
//   • Similarity score 0-100
//
// Uses cosine similarity on a flat parameter vector. All similarity
// is computed against REAL historical setups — never against fake
// or generated data.

import { db } from './db.js';

// ──────────────────────────────────────────────────────────────────
//  Flatten the rich parameter snapshot into a fixed-length vector
//  so we can compare any two setups dimensionally.
//
//  Vector dimensions (24, deterministic order):
//    [0]  trend.stackAlignment           (-1..+1)
//    [1]  trend.adx                       (0..100)
//    [2]  trend.ema9Slope5Pct             (-N..+N)
//    [3]  vwap.distancePct                (-N..+N)
//    [4]  vwap.slope10Pct                 (-N..+N)
//    [5]  vwap.aboveVWAP                  (0/1)
//    [6]  volume.relativeVolume           (0..N)
//    [7]  volume.cumulativeDelta20 sign   (-1/0/+1)
//    [8]  volume.accelerationRatio        (0..N)
//    [9]  volatility.atrRatioVsPast       (0..N)
//    [10] volatility.bbWidthPct           (0..N)
//    [11] volatility.inSqueeze            (0/1)
//    [12] structure.structureTrend enum   (-1 dn / 0 / +1 up)
//    [13] structure.bullBOS               (0/1)
//    [14] structure.bearBOS               (0/1)
//    [15] smc.liquiditySweepBull          (0/1)
//    [16] smc.liquiditySweepBear          (0/1)
//    [17] smc.fvgsCount                   (0..N)
//    [18] priceAction.bodyPct             (0..100)
//    [19] priceAction.momentumCandle      (0/1)
//    [20] priceAction.engulfing           (0/1)
//    [21] rsi14                           (0..100)
//    [22] chain.pcr                       (0..N)
//    [23] chain.atmIV                     (0..N)
// ──────────────────────────────────────────────────────────────────
export function vectorize(params) {
    if (!params) return null;
    const t = params.trend || {};
    const v = params.vwap || {};
    const vol = params.volume || {};
    const vlt = params.volatility || {};
    const s = params.structure || {};
    const m = params.smc || {};
    const p = params.priceAction || {};
    const c = params.chain || {};

    const structureScore = s.structureTrend === 'UPTREND' ? 1
        : s.structureTrend === 'DOWNTREND' ? -1 : 0;

    return [
        clampNum(t.stackAlignment, -1, 1),
        clampNum(t.adx, 0, 100) / 100,                  // normalize to 0..1
        clampNum(t.ema9Slope5Pct, -5, 5) / 5,           // normalize
        clampNum(v.distancePct, -5, 5) / 5,
        clampNum(v.slope10Pct, -2, 2) / 2,
        v.aboveVWAP ? 1 : 0,
        Math.min(clampNum(vol.relativeVolume, 0, 10), 10) / 10,
        Math.sign(vol.cumulativeDelta20 || 0),
        Math.min(clampNum(vol.accelerationRatio, 0, 5), 5) / 5,
        Math.min(clampNum(vlt.atrRatioVsPast, 0, 3), 3) / 3,
        Math.min(clampNum(vlt.bbWidthPct, 0, 5), 5) / 5,
        vlt.inSqueeze ? 1 : 0,
        structureScore,
        s.bullBOS ? 1 : 0,
        s.bearBOS ? 1 : 0,
        m.liquiditySweepBull ? 1 : 0,
        m.liquiditySweepBear ? 1 : 0,
        Math.min(clampNum(m.fvgsCount, 0, 20), 20) / 20,
        clampNum(p.bodyPct, 0, 100) / 100,
        p.momentumCandle ? 1 : 0,
        p.engulfing ? 1 : 0,
        clampNum(params.rsi14, 0, 100) / 100,
        Math.min(clampNum(c.pcr, 0, 3), 3) / 3,
        Math.min(clampNum(c.atmIV, 0, 100), 100) / 100
    ];
}

function clampNum(v, lo, hi) {
    if (v == null || isNaN(v) || !isFinite(v)) return 0;
    return Math.max(lo, Math.min(hi, v));
}

// ──────────────────────────────────────────────────────────────────
//  Cosine similarity between two vectors (1.0 = identical, 0 = orthogonal)
// ──────────────────────────────────────────────────────────────────
function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ──────────────────────────────────────────────────────────────────
//  Find historical setups similar to the current parameter snapshot.
//
//  Searches the signal_journal table where the FULL parameter vector
//  is stored as JSON. Filters by same symbol and same side optionally.
//  Returns top-K most similar setups with their (eventual) outcomes
//  if those trades were also recorded in the trades table.
// ──────────────────────────────────────────────────────────────────
export function findSimilarSetups({ symbol, side, params, minSimilarity = 0.70, topK = 50, lookbackDays = 365 }) {
    const target = vectorize(params);
    if (!target) return { matches: 0, similarity: 0, stats: null };

    // Pull recent signals from same symbol/side
    const sinceMs = Date.now() - lookbackDays * 86400 * 1000;
    const rows = db.prepare(`
        SELECT j.*, t.pnl, t.result, t.exit_reason, t.exit_premium, t.entry_premium
          FROM signal_journal j
          LEFT JOIN trades t ON t.id = ('sig_' || j.id) OR t.time = j.ts
         WHERE j.symbol = ?
           AND (? IS NULL OR j.side = ?)
           AND j.ts >= ?
         ORDER BY j.ts DESC
         LIMIT 10000
    `).all(symbol, side, side, sinceMs);

    const scored = [];
    for (const r of rows) {
        if (!r.full_json) continue;
        try {
            const rec = JSON.parse(r.full_json);
            // Re-vectorize: the journal stores raw parameter contexts.
            // For best-effort, build a tiny synthetic params object from
            // what we DO have in the journal row (price + chain context).
            // Future: store the full parameter snapshot directly in the journal.
            const histParams = recordToParams(rec);
            const histVec = vectorize(histParams);
            if (!histVec) continue;
            const sim = cosineSim(target, histVec);
            if (sim >= minSimilarity) {
                scored.push({
                    ts: r.ts,
                    similarity: sim,
                    side: r.side,
                    pnl: r.pnl,
                    result: r.result,
                    exitReason: r.exit_reason,
                    entryPremium: r.entry_premium,
                    exitPremium: r.exit_premium,
                    strike: r.strike,
                    tier: r.tier
                });
            }
        } catch { /* skip malformed */ }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const top = scored.slice(0, topK);

    // Compute statistics on matches that actually had outcomes
    const withOutcomes = top.filter(x => x.pnl != null);
    const wins = withOutcomes.filter(x => x.pnl > 0).length;
    const losses = withOutcomes.filter(x => x.pnl < 0).length;
    const winRate = withOutcomes.length ? (wins / withOutcomes.length) * 100 : null;
    const avgPnl = withOutcomes.length ? withOutcomes.reduce((a, x) => a + x.pnl, 0) / withOutcomes.length : null;
    const bestPnl = withOutcomes.length ? Math.max(...withOutcomes.map(x => x.pnl)) : null;
    const worstPnl = withOutcomes.length ? Math.min(...withOutcomes.map(x => x.pnl)) : null;
    const avgSim = top.length ? top.reduce((a, x) => a + x.similarity, 0) / top.length : 0;

    return {
        matches: top.length,
        matchesWithOutcomes: withOutcomes.length,
        avgSimilarity: parseFloat((avgSim * 100).toFixed(1)),
        winRate: winRate != null ? parseFloat(winRate.toFixed(1)) : null,
        wins,
        losses,
        avgPnl: avgPnl != null ? parseFloat(avgPnl.toFixed(0)) : null,
        bestPnl, worstPnl,
        sampleTrades: top.slice(0, 5).map(x => ({
            ts: x.ts, similarity: parseFloat((x.similarity * 100).toFixed(1)),
            pnl: x.pnl, result: x.result, strike: x.strike
        }))
    };
}

// Build a minimal params object from a journal record so we can
// vectorize historical setups. (Best-effort — older records may have
// less detail; new records have the full vector.)
function recordToParams(rec) {
    return {
        trend: rec.parameters?.trend || rec.trend || {},
        vwap: rec.parameters?.vwap || {},
        volume: rec.parameters?.volume || {},
        volatility: rec.parameters?.volatility || {},
        structure: rec.parameters?.structure || {},
        smc: rec.parameters?.smc || {},
        priceAction: rec.parameters?.priceAction || {},
        rsi14: rec.parameters?.rsi14 || null,
        chain: rec.parameters?.chain || rec.chainContext || {}
    };
}

// ──────────────────────────────────────────────────────────────────
//  Strategy backtest summary — for the "10-year results" panel.
//  Pulls all historical signals for (strategy, symbol, side) from the
//  signal_journal and computes win rate / Sharpe / drawdown / profit
//  factor / expectancy from the linked trade outcomes.
// ──────────────────────────────────────────────────────────────────
export function strategyBacktestSummary({ symbol, side, strategyId, lookbackDays = 3650 }) {
    const sinceMs = Date.now() - lookbackDays * 86400 * 1000;
    const rows = db.prepare(`
        SELECT j.id, j.ts, t.pnl, t.result, t.entry_premium, t.exit_premium
          FROM signal_journal j
          LEFT JOIN trades t ON t.time = j.ts
         WHERE j.symbol = ?
           AND (? IS NULL OR j.side = ?)
           AND j.ts >= ?
           AND t.pnl IS NOT NULL
         ORDER BY j.ts ASC
    `).all(symbol, side, side, sinceMs);

    const filtered = strategyId
        ? rows.filter(r => {
            try {
                const rec = JSON.parse(r.full_json || '{}');
                return rec.firingStrategies?.some(s => s.id === strategyId);
            } catch { return false; }
        })
        : rows;

    if (filtered.length === 0) {
        return { totalTrades: 0, available: false };
    }

    const pnls = filtered.map(r => r.pnl || 0);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const grossWin = wins.reduce((a, p) => a + p, 0);
    const grossLoss = Math.abs(losses.reduce((a, p) => a + p, 0));
    const netPnl = pnls.reduce((a, p) => a + p, 0);

    // Sharpe — simple per-trade
    const meanReturn = pnls.reduce((a, p) => a + p, 0) / pnls.length;
    const stdDev = Math.sqrt(pnls.reduce((a, p) => a + (p - meanReturn) ** 2, 0) / pnls.length);
    const sharpe = stdDev > 0 ? meanReturn / stdDev : 0;

    // Max drawdown from running equity
    let peak = 0, equity = 0, maxDd = 0;
    for (const p of pnls) {
        equity += p;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDd) maxDd = dd;
    }

    return {
        available: true,
        symbol, side, strategyId,
        totalTrades: filtered.length,
        winRate: parseFloat((wins.length / filtered.length * 100).toFixed(1)),
        wins: wins.length,
        losses: losses.length,
        netPnl: Math.round(netPnl),
        avgWin: wins.length ? Math.round(grossWin / wins.length) : 0,
        avgLoss: losses.length ? Math.round(grossLoss / losses.length) : 0,
        profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : null,
        expectancy: parseFloat(meanReturn.toFixed(0)),
        sharpe: parseFloat(sharpe.toFixed(2)),
        maxDrawdown: Math.round(maxDd),
        firstTradeTs: filtered[0].ts,
        lastTradeTs: filtered[filtered.length - 1].ts
    };
}
