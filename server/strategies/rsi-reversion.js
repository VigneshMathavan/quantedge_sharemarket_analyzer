// strategies/rsi-reversion.js — RSI mean-reversion fader.
//
// Fires when:
//   • RSI(14) is extreme (>72 oversold-of-extended-up, <28 overbought-of-extended-down)
//   • Current candle shows reversal characteristics (small body + opposite-side wick)
//   • ADX is LOW (<22) — meaning no strong trend, so reversal is more likely
//
// Why this works on ranging/quiet days:
//   Most retail strategies are trend-following. When markets are choppy, the
//   trend strategies stay out (good). But the price still oscillates — and
//   that oscillation is where reversion strategies fire. RSI extremes mark
//   the edges of the range.
//
// CALL signal: market just sold off (RSI < 28) → expect bounce → BUY CALL
// PUT signal:  market just rallied (RSI > 72) → expect fade  → BUY PUT

export const rsiReversionStrategy = {
    id: 'rsi_reversion',
    name: 'RSI Extreme Reversion',
    marketBias: 'chop',
    weight: 14,

    detect({ candles, indicators, last }) {
        const rsiV = indicators.rsi14[indicators.rsi14.length - 1] || 50;
        const rsiPrev = indicators.rsi14[indicators.rsi14.length - 3] || 50;
        const adxRow = indicators.adx14[indicators.adx14.length - 1];
        const adxV = adxRow?.adx || 20;

        if (adxV > 28) {
            return { fired: false, reason: `ADX ${adxV.toFixed(1)} too strong — trend in play, skip reversion`, metrics: { rsiV, adxV } };
        }

        const range = last.high - last.low;
        const bodyTop = Math.max(last.open, last.close);
        const bodyBot = Math.min(last.open, last.close);
        const body = bodyTop - bodyBot;
        const upperWick = last.high - bodyTop;
        const lowerWick = bodyBot - last.low;

        // Oversold bounce → CALL
        if (rsiV < 30) {
            const rejection = lowerWick > range * 0.35 && last.close >= last.open;
            return {
                fired: rejection,
                side: 'BUY_CALL',
                reason: rejection
                    ? `RSI ${rsiV.toFixed(1)} oversold + lower-wick rejection`
                    : `RSI ${rsiV.toFixed(1)} oversold but no rejection candle yet`,
                metrics: { rsiV, rsiPrev, adxV, lowerWickPct: lowerWick / range }
            };
        }

        // Overbought fade → PUT
        if (rsiV > 70) {
            const rejection = upperWick > range * 0.35 && last.close <= last.open;
            return {
                fired: rejection,
                side: 'BUY_PUT',
                reason: rejection
                    ? `RSI ${rsiV.toFixed(1)} overbought + upper-wick rejection`
                    : `RSI ${rsiV.toFixed(1)} overbought but no rejection candle yet`,
                metrics: { rsiV, rsiPrev, adxV, upperWickPct: upperWick / range }
            };
        }

        return { fired: false, reason: `RSI ${rsiV.toFixed(1)} — within neutral band`, metrics: { rsiV, adxV } };
    }
};
