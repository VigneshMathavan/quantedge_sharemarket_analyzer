// server/mtf-alignment.js
//
// MULTI-TIMEFRAME ALIGNMENT per the master spec.
// For every signal, compute the bullish/bearish/neutral bias on each
// of the 7 timeframes (1m/3m/5m/15m/30m/60m/Daily) using a fast,
// uniform method that doesn't require running the full strategy
// orchestrator on each TF.
//
// Method per TF:
//   • Fetch last N candles for that TF
//   • Compute trend stack (EMA9/20/50 + price)
//   • Bias = sum of (price>ema9 + ema9>ema20 + ema20>ema50) → -3..+3
//   • Map to BULL / NEUTRAL / BEAR
//
// Output: alignment grid {tf: 'BULL'|'NEUTRAL'|'BEAR'} for UI rendering.

import { computeAllParameters } from './parameter-engine.js';

const TFS = ['1minute', '3minute', '5minute', '15minute', '30minute', '60minute', '1day'];
const TF_LABELS = { '1minute': '1m', '3minute': '3m', '5minute': '5m', '15minute': '15m', '30minute': '30m', '60minute': '1h', '1day': '1D' };

export async function computeMTFAlignment({ provider, symbol, side }) {
    const results = {};
    const promises = TFS.map(async tf => {
        try {
            const candles = await provider.getHistorical(symbol, tf, 60);
            if (!candles || candles.length < 30) {
                results[TF_LABELS[tf]] = { tf, status: 'INSUFFICIENT_DATA', score: null };
                return;
            }
            const params = computeAllParameters({ candles, chain: null, spot: candles[candles.length - 1].close });
            const t = params.trend || {};
            // Quick alignment score from EMA stack + slope + ADX
            const stackPts = t.stackAlignment || 0;           // -1..+1
            const slope = t.ema9Slope5Pct || 0;                // % move
            const slopeBias = Math.tanh(slope) || 0;           // squash to -1..+1
            const adxBoost = Math.min(1, (t.adx || 0) / 30);   // 0..1, scales conviction
            const raw = (stackPts * 0.6 + slopeBias * 0.4) * (0.5 + adxBoost * 0.5);

            const bias = raw > 0.25 ? 'BULL'
                : raw < -0.25 ? 'BEAR' : 'NEUTRAL';
            const aligned = (side === 'BUY_CALL' && bias === 'BULL') ||
                            (side === 'BUY_PUT' && bias === 'BEAR');

            results[TF_LABELS[tf]] = {
                tf, bias,
                score: parseFloat(raw.toFixed(3)),
                aligned,
                ema9: t.ema9?.toFixed(2),
                adx: t.adx
            };
        } catch (e) {
            results[TF_LABELS[tf]] = { tf, status: 'ERROR', error: e.message };
        }
    });
    await Promise.all(promises);

    // Aggregate alignment score
    const valid = Object.values(results).filter(r => r.bias);
    const aligned = valid.filter(r => r.aligned).length;
    const total = valid.length;
    const alignmentPct = total ? parseFloat((aligned / total * 100).toFixed(1)) : 0;

    return {
        grid: results,
        alignedCount: aligned,
        totalTfs: total,
        alignmentPct,
        verdict: alignmentPct >= 70 ? 'STRONG_ALIGN' :
                 alignmentPct >= 50 ? 'PARTIAL_ALIGN' :
                 alignmentPct >= 30 ? 'WEAK_ALIGN' : 'AGAINST_TREND'
    };
}
