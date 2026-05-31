// strategies/ema-pullback.js — 20 EMA pullback in established trend.
//
// Classic trend-continuation pattern. When market is trending and price
// pulls back to the 20 EMA, that's the institutional add-on entry.
//
// Fires when:
//   • EMA20 slope is clearly directional (last 5 EMA values trending)
//   • Current candle touched or near touched EMA20 (low/high near it)
//   • Candle closes in trend direction (closes above for uptrend)
//   • Body > 50% of range

export const emaPullbackStrategy = {
    id: 'ema_pullback',
    name: '20 EMA Pullback',
    marketBias: 'trending',
    weight: 17,

    detect({ candles, indicators, last }) {
        const e20 = indicators.ema20;
        if (e20.length < 5) return { fired: false, reason: 'EMA20 not ready' };

        const ema20Now = e20[e20.length - 1];
        const ema20Prev5 = e20[e20.length - 6] ?? ema20Now;
        const slope = ((ema20Now - ema20Prev5) / ema20Prev5) * 100;

        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const bodyPct = range > 0 ? body / range : 0;

        // Touch tolerance: low/high within 0.05% of EMA20
        const touchedFromAbove = last.low <= ema20Now * 1.0005 && last.close > ema20Now;
        const touchedFromBelow = last.high >= ema20Now * 0.9995 && last.close < ema20Now;

        // UPTREND pullback
        if (slope > 0.04 && touchedFromAbove && last.close > last.open && bodyPct > 0.5) {
            return {
                fired: true,
                side: 'BUY_CALL',
                reason: `Uptrend EMA20 pullback rejected (slope +${slope.toFixed(2)}%, body ${(bodyPct*100).toFixed(0)}%)`,
                metrics: { ema20: ema20Now, slope, bodyPct }
            };
        }
        // DOWNTREND pullback
        if (slope < -0.04 && touchedFromBelow && last.close < last.open && bodyPct > 0.5) {
            return {
                fired: true,
                side: 'BUY_PUT',
                reason: `Downtrend EMA20 pullback rejected (slope ${slope.toFixed(2)}%, body ${(bodyPct*100).toFixed(0)}%)`,
                metrics: { ema20: ema20Now, slope, bodyPct }
            };
        }
        return {
            fired: false,
            reason: Math.abs(slope) < 0.04 ? `EMA20 slope ${slope.toFixed(2)}% — no trend to ride` : `near EMA20 but no rejection`
        };
    }
};
