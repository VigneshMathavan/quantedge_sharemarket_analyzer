// server/multi-index-scanner.js
//
// CROSS-INDEX INTELLIGENCE per the master spec.
// Scans NIFTY + BANKNIFTY + FINNIFTY + SENSEX in parallel on every
// poll. Returns a ranked grid of which index has the strongest setup
// right now, with side / tier / confluence / regime per cell.
//
// Powers the "Cross-Index Opportunities" panel — at a glance the user
// sees where the highest-conviction setup is across all 4 markets.

import { StrategyOrchestrator } from './strategies/base.js';
import { orbStrategy } from './strategies/orb.js';
import { vwapContinuationStrategy } from './strategies/vwap-continuation.js';
import { supertrendEmaStrategy } from './strategies/supertrend-ema.js';
import { rsiReversionStrategy } from './strategies/rsi-reversion.js';
import { bbSqueezeStrategy } from './strategies/bb-squeeze.js';
import { momentumBurstStrategy } from './strategies/momentum-burst.js';
import { rangeExpansionStrategy } from './strategies/range-expansion.js';
import { insideBarStrategy } from './strategies/inside-bar.js';
import { vwapCrossStrategy } from './strategies/vwap-cross.js';
import { emaPullbackStrategy } from './strategies/ema-pullback.js';
import { volumeClimaxStrategy } from './strategies/volume-climax.js';
import { cprBreakoutStrategy, cprReversalStrategy } from './strategies/cpr-strategy.js';
import { computeAllParameters } from './parameter-engine.js';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];
const orchestrator = new StrategyOrchestrator([
    orbStrategy, vwapContinuationStrategy, supertrendEmaStrategy,
    rsiReversionStrategy, bbSqueezeStrategy, momentumBurstStrategy,
    rangeExpansionStrategy, insideBarStrategy, vwapCrossStrategy,
    emaPullbackStrategy, volumeClimaxStrategy,
    cprBreakoutStrategy, cprReversalStrategy
]);

export async function scanAllIndices({ provider, tf = '5minute', count = 220 }) {
    const start = Date.now();
    const promises = SYMBOLS.map(async symbol => {
        try {
            const candles = await provider.getHistorical(symbol, tf, count);
            if (!candles || candles.length < 60) {
                return { symbol, status: 'INSUFFICIENT_DATA' };
            }
            const result = await orchestrator.evaluate({
                candles, vix: 15, eventGate: { ok: true },
                newsSentiment: null, mlScorer: null
            });
            const firing = (result.votes || []).filter(v => v.fired);
            const params = computeAllParameters({ candles, chain: null, spot: candles[candles.length - 1].close });
            const tier = firing.length >= 3 ? 'STRONG'
                : firing.length >= 2 ? 'LIKELY'
                : firing.length >= 1 ? 'POTENTIAL' : 'NONE';

            return {
                symbol,
                spot: candles[candles.length - 1].close,
                side: result.side,
                tier,
                confluenceScore: result.confluenceScore || 0,
                firingCount: firing.length,
                firingNames: firing.map(v => v.name),
                regime: result.regime?.regime || null,
                adx: params.trend?.adx,
                rsi: params.rsi14,
                aboveVwap: params.vwap?.aboveVWAP,
                structure: params.structure?.structureTrend,
                bullBOS: params.structure?.bullBOS,
                bearBOS: params.structure?.bearBOS
            };
        } catch (e) {
            return { symbol, status: 'ERROR', error: e.message.slice(0, 80) };
        }
    });

    const results = await Promise.all(promises);

    // Rank by tier (STRONG > LIKELY > POTENTIAL > NONE), then confluence
    const tierRank = { STRONG: 3, LIKELY: 2, POTENTIAL: 1, NONE: 0 };
    results.sort((a, b) => {
        const ta = tierRank[a.tier] || 0, tb = tierRank[b.tier] || 0;
        if (ta !== tb) return tb - ta;
        return (b.confluenceScore || 0) - (a.confluenceScore || 0);
    });

    return {
        ts: Date.now(),
        tookMs: Date.now() - start,
        tf,
        indices: results,
        bestOpportunity: results.find(r => r.tier !== 'NONE' && r.tier !== undefined) || null
    };
}
