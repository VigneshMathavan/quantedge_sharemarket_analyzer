// strategies/range-expansion.js — ATR expansion detector.
//
// Catches the moment market transitions from low-vol to high-vol. The
// 5-candle ATR jumping >1.5x the 20-candle ATR is a classic regime change
// signal — institutions stepping in / breaking out / event-driven moves.
//
// Different from Momentum Burst:
//   • Momentum Burst = single big candle right now
//   • Range Expansion = trend of EXPANDING candles over the last 5
//
// Fires when:
//   • atr(5) / atr(20) > 1.5
//   • Last 3 candles trending same direction (close > open OR < open, 2 of 3)
//   • Net move over last 5 candles > 0.15%

import { atr } from '../signal2.js';

export const rangeExpansionStrategy = {
    id: 'range_expansion',
    name: 'Range Expansion',
    marketBias: 'any',
    weight: 18,

    detect({ candles, last }) {
        if (candles.length < 30) return { fired: false, reason: 'insufficient history' };

        const atr5Series = atr(candles, 5);
        const atr20Series = atr(candles, 20);
        if (atr5Series.length === 0 || atr20Series.length === 0) {
            return { fired: false, reason: 'ATR series not ready' };
        }
        const atr5 = atr5Series[atr5Series.length - 1];
        const atr20 = atr20Series[atr20Series.length - 1];
        const ratio = atr20 > 0 ? atr5 / atr20 : 0;

        if (ratio < 1.5) {
            return {
                fired: false,
                reason: `ATR5/ATR20 = ${ratio.toFixed(2)} (need >1.5)`,
                metrics: { atr5, atr20, ratio }
            };
        }

        // Direction confirmation: out of last 3 candles, at least 2 same side
        const last3 = candles.slice(-3);
        const upCount = last3.filter(c => c.close > c.open).length;
        const dnCount = last3.filter(c => c.close < c.open).length;

        if (upCount < 2 && dnCount < 2) {
            return {
                fired: false,
                reason: `ATR expanded (${ratio.toFixed(2)}×) but direction mixed`,
                metrics: { atr5, atr20, ratio, upCount, dnCount }
            };
        }

        // Magnitude check — net move over last 5 candles
        const fiveBack = candles[candles.length - 6]?.close || last.close;
        const netMovePct = Math.abs(last.close - fiveBack) / fiveBack * 100;
        if (netMovePct < 0.15) {
            return {
                fired: false,
                reason: `ATR expanded but net move only ${netMovePct.toFixed(2)}%`,
                metrics: { atr5, atr20, ratio, netMovePct }
            };
        }

        const side = upCount > dnCount ? 'BUY_CALL' : 'BUY_PUT';

        return {
            fired: true,
            side,
            reason: `Range expanding (ATR ${ratio.toFixed(2)}×) ${upCount > dnCount ? '↑' : '↓'} net +${netMovePct.toFixed(2)}% in 5 candles`,
            metrics: { atr5, atr20, ratio, upCount, dnCount, netMovePct }
        };
    }
};
