// strategies/vwap-continuation.js — VWAP Pullback / Continuation
//
// Classic intraday pro trade: on trend days, price pulls back to VWAP and
// continues. This strategy fires when:
//
//   1. EMA9 trend is clearly directional (slope confirms)
//   2. Price has pulled back to within X% of VWAP from the trend side
//   3. The current candle shows rejection (lower wick on a long, upper wick on a short)
//   4. RSI is not at the extreme (avoid catching a knife in overbought/oversold)
//   5. ADX > 20 confirms there IS a trend to follow
//
// Why this works: VWAP is the institutional benchmark. When price returns to
// it during a trend day, institutions step in to reload. Retail riding the
// trend often gets shaken out, only for the move to resume.

export const vwapContinuationStrategy = {
    id: 'vwap_continuation',
    name: 'VWAP Pullback Continuation',
    marketBias: 'trending',
    weight: 20,

    detect({ candles, indicators, timeIST, last }) {
        const vwapSer = indicators.vwap;
        if (!vwapSer.length) return { fired: false, reason: 'VWAP not ready' };
        const vwapV = vwapSer[vwapSer.length - 1];
        const ema9V = indicators.ema9[indicators.ema9.length - 1];
        const ema9Prev = indicators.ema9[indicators.ema9.length - 6] ?? ema9V; // 5 candles back
        const rsiV = indicators.rsi14[indicators.rsi14.length - 1] || 50;
        const adxRow = indicators.adx14[indicators.adx14.length - 1];
        const adxV = adxRow?.adx || 0;

        // Need a real trend
        if (adxV < 20) return { fired: false, reason: `ADX ${adxV.toFixed(1)} too weak — no trend to ride` };

        // EMA9 slope (last 5 candles)
        const ema9Slope = (ema9V - ema9Prev) / ema9Prev * 100;
        const distFromVwap = (last.close - vwapV) / vwapV * 100;

        // Candle body & wick analysis
        const bodyTop = Math.max(last.open, last.close);
        const bodyBot = Math.min(last.open, last.close);
        const upperWick = last.high - bodyTop;
        const lowerWick = bodyBot - last.low;
        const range = last.high - last.low;

        // UPTREND scenario
        if (ema9Slope > 0.05 && rsiV < 75) {
            // Price has pulled back to within 0.2% of VWAP (or briefly below it)
            const nearVwap = distFromVwap < 0.20 && distFromVwap > -0.15;
            // Rejection candle: lower wick > 40% of range AND closes above the body's lower half
            const rejection = lowerWick > range * 0.4 && last.close > (bodyBot + bodyTop) / 2;
            if (nearVwap && rejection) {
                return {
                    fired: true,
                    side: 'BUY_CALL',
                    reason: `Uptrend pullback to VWAP rejected (lower wick ${(lowerWick / range * 100).toFixed(0)}% of range)`,
                    metrics: { vwapV, distFromVwap, ema9Slope, rsiV, adxV, wickPct: lowerWick / range }
                };
            }
            return { fired: false, reason: nearVwap ? 'near VWAP but no rejection candle yet' : `${distFromVwap.toFixed(2)}% from VWAP — wait for pullback`, metrics: { vwapV, distFromVwap, ema9Slope } };
        }

        // DOWNTREND scenario
        if (ema9Slope < -0.05 && rsiV > 25) {
            const nearVwap = distFromVwap > -0.20 && distFromVwap < 0.15;
            const rejection = upperWick > range * 0.4 && last.close < (bodyBot + bodyTop) / 2;
            if (nearVwap && rejection) {
                return {
                    fired: true,
                    side: 'BUY_PUT',
                    reason: `Downtrend pullback to VWAP rejected (upper wick ${(upperWick / range * 100).toFixed(0)}% of range)`,
                    metrics: { vwapV, distFromVwap, ema9Slope, rsiV, adxV, wickPct: upperWick / range }
                };
            }
            return { fired: false, reason: nearVwap ? 'near VWAP but no rejection candle yet' : `${distFromVwap.toFixed(2)}% from VWAP — wait for pullback`, metrics: { vwapV, distFromVwap, ema9Slope } };
        }

        return { fired: false, reason: 'no directional EMA9 slope', metrics: { ema9Slope: ema9Slope.toFixed(3), rsiV, adxV } };
    }
};
