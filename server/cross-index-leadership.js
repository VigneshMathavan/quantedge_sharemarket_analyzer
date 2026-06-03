// server/cross-index-leadership.js — Priority 12: Cross-Index Leadership
//
// Determines which of NIFTY/BANKNIFTY/FINNIFTY/SENSEX is currently
// LEADING (strongest momentum) vs LAGGING. Uses rolling 30-min
// return + ADX as the leadership score.
//
// Output: ranked leadership grid + correlation hint between the
// firing signal's index and the strongest leader.

import { computeAllParameters } from './parameter-engine.js';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];

export async function computeCrossIndexLeadership({ provider, side, currentSymbol }) {
    const out = [];
    await Promise.all(SYMBOLS.map(async sym => {
        try {
            const candles = await provider.getHistorical(sym, '5minute', 30);
            if (!candles || candles.length < 10) return;
            const first = candles[0].close;
            const last = candles[candles.length - 1].close;
            const ret30Pct = ((last - first) / first) * 100;
            const params = computeAllParameters({ candles, chain: null, spot: last });
            const adx = params.trend?.adx || 0;
            const stack = params.trend?.stackAlignment || 0;
            const aboveVwap = params.vwap?.aboveVWAP ? 1 : -1;
            // Composite leadership score — directional, signed
            const score = ret30Pct * 0.5 + stack * 15 * 0.3 + aboveVwap * 5 * 0.2;
            out.push({
                symbol: sym,
                ret30Pct: parseFloat(ret30Pct.toFixed(2)),
                adx: adx ? parseFloat(adx.toFixed(1)) : null,
                stackAlignment: stack,
                aboveVwap: params.vwap?.aboveVWAP,
                leadershipScore: parseFloat(score.toFixed(2))
            });
        } catch (_) {}
    }));

    // Rank by absolute leadership (strongest move either direction)
    const sorted = [...out].sort((a, b) => Math.abs(b.leadershipScore) - Math.abs(a.leadershipScore));
    const leader = sorted[0];
    const laggard = sorted[sorted.length - 1];

    // Confirmation: is the leader moving in the direction the current
    // signal would benefit from?
    const directionalLeader = sorted.find(x =>
        side === 'BUY_CALL' ? x.leadershipScore > 0 : x.leadershipScore < 0
    );
    const currentRow = out.find(x => x.symbol === currentSymbol);
    const alignedWithLeader = directionalLeader && currentRow
        ? (Math.sign(directionalLeader.leadershipScore) === Math.sign(currentRow.leadershipScore))
        : false;

    return {
        ts: Date.now(),
        ranked: sorted,
        leader: leader ? { symbol: leader.symbol, score: leader.leadershipScore } : null,
        laggard: laggard ? { symbol: laggard.symbol, score: laggard.leadershipScore } : null,
        directionalLeader: directionalLeader
            ? { symbol: directionalLeader.symbol, score: directionalLeader.leadershipScore }
            : null,
        alignedWithLeader,
        confirmation: alignedWithLeader ? 'STRONG' : currentRow && Math.sign(currentRow.leadershipScore) !== Math.sign(leader.leadershipScore) ? 'CONFLICTING' : 'NEUTRAL'
    };
}
