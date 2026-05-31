// server/levels.js — Support/Resistance + OI walls.
//
// Two functions for the chart overlay system:
//   1. computeSR(candles, lookback, clusterPct) — fractal pivot detection,
//      then clusters nearby levels so we don't draw 8 lines on top of each other.
//   2. detectOIWalls(chain) — finds the strikes with the most CE OI (resistance)
//      and PE OI (support) — these are where institutions have written options.

// ============================================================
//  Support / Resistance — fractal pivot method
// ============================================================
export function computeSR(candles, opts = {}) {
    const {
        lookback = 80,        // how far back to scan
        leftRight = 2,        // pivot needs to be higher/lower than N candles on each side
        clusterPct = 0.0015,  // cluster levels within 0.15% of each other
        maxLevels = 4         // top N supports + top N resistances
    } = opts;
    if (candles.length < leftRight * 2 + 1) return { supports: [], resistances: [] };

    const start = Math.max(leftRight, candles.length - lookback);
    const pivotsHigh = [], pivotsLow = [];
    const last = candles[candles.length - 1];

    for (let i = start; i < candles.length - leftRight; i++) {
        const c = candles[i];
        let isHigh = true, isLow = true;
        for (let j = 1; j <= leftRight; j++) {
            if (candles[i - j].high >= c.high) isHigh = false;
            if (candles[i + j].high >= c.high) isHigh = false;
            if (candles[i - j].low <= c.low) isLow = false;
            if (candles[i + j].low <= c.low) isLow = false;
        }
        // Score = how recent + how "strong" (how much it stuck out)
        if (isHigh) {
            const recency = (i - start) / (candles.length - start);
            pivotsHigh.push({ price: c.high, time: c.time, score: recency });
        }
        if (isLow) {
            const recency = (i - start) / (candles.length - start);
            pivotsLow.push({ price: c.low, time: c.time, score: recency });
        }
    }

    function clusterAndPick(pivots, isResistance) {
        if (pivots.length === 0) return [];
        // Sort by price
        const sorted = [...pivots].sort((a, b) => a.price - b.price);
        const clusters = [];
        let cur = { prices: [sorted[0].price], scores: [sorted[0].score] };
        for (let i = 1; i < sorted.length; i++) {
            const avgCur = cur.prices.reduce((a, b) => a + b, 0) / cur.prices.length;
            if (Math.abs(sorted[i].price - avgCur) / avgCur < clusterPct) {
                cur.prices.push(sorted[i].price);
                cur.scores.push(sorted[i].score);
            } else {
                clusters.push(cur);
                cur = { prices: [sorted[i].price], scores: [sorted[i].score] };
            }
        }
        clusters.push(cur);

        // Score each cluster: more touches + more recent = stronger
        const ranked = clusters.map(c => {
            const avgPrice = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
            const touchScore = c.prices.length;
            const recencyScore = Math.max(...c.scores);
            return {
                price: parseFloat(avgPrice.toFixed(2)),
                touches: touchScore,
                strength: parseFloat((touchScore + recencyScore * 2).toFixed(2)),
                type: isResistance ? 'R' : 'S'
            };
        });

        // For resistances: take ones ABOVE current price; supports BELOW
        const filtered = isResistance
            ? ranked.filter(r => r.price > last.close)
            : ranked.filter(r => r.price < last.close);
        filtered.sort((a, b) => b.strength - a.strength);
        return filtered.slice(0, maxLevels);
    }

    return {
        supports: clusterAndPick(pivotsLow, false),
        resistances: clusterAndPick(pivotsHigh, true),
        spot: last.close
    };
}

// ============================================================
//  OI walls — biggest call/put writing strikes
// ============================================================
export function detectOIWalls(chain, opts = {}) {
    const { topN = 3, spot = null } = opts;
    if (!chain || chain.length === 0) return { resistance: [], support: [], spot };

    const ces = chain.filter(o => o.type === 'CE').sort((a, b) => b.oi - a.oi);
    const pes = chain.filter(o => o.type === 'PE').sort((a, b) => b.oi - a.oi);

    const totalCeOI = ces.reduce((a, b) => a + b.oi, 0) || 1;
    const totalPeOI = pes.reduce((a, b) => a + b.oi, 0) || 1;

    // Top CE OI strikes are where CALL writers have sold — caps upside (resistance)
    const resistance = ces.slice(0, topN).map(o => ({
        strike: o.strike,
        oi: o.oi,
        oiShare: parseFloat(((o.oi / totalCeOI) * 100).toFixed(1)),
        type: 'CALL_WALL'
    })).sort((a, b) => a.strike - b.strike);

    // Top PE OI strikes are where PUT writers have sold — floors downside (support)
    const support = pes.slice(0, topN).map(o => ({
        strike: o.strike,
        oi: o.oi,
        oiShare: parseFloat(((o.oi / totalPeOI) * 100).toFixed(1)),
        type: 'PUT_WALL'
    })).sort((a, b) => a.strike - b.strike);

    // Max pain — simplified: weighted center of OI
    const allStrikes = [...new Set(chain.map(o => o.strike))].sort((a, b) => a - b);
    let bestStrike = 0, minLoss = Infinity;
    for (const k of allStrikes) {
        let loss = 0;
        for (const o of chain) {
            if (o.type === 'CE' && o.strike < k) loss += (k - o.strike) * o.oi;
            else if (o.type === 'PE' && o.strike > k) loss += (o.strike - k) * o.oi;
        }
        if (loss < minLoss) { minLoss = loss; bestStrike = k; }
    }

    return { resistance, support, spot, maxPain: bestStrike };
}
