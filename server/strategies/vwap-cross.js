// strategies/vwap-cross.js — VWAP cross with momentum.
//
// Fires when price crosses VWAP with body confirmation. This is a regime-
// change signal — institutional bias flip. Different from VWAP Pullback
// (which fades back to VWAP); this catches the BREAK across it.

export const vwapCrossStrategy = {
    id: 'vwap_cross',
    name: 'VWAP Cross',
    marketBias: 'any',
    weight: 16,

    detect({ candles, indicators, last }) {
        const vw = indicators.vwap;
        if (vw.length < 5) return { fired: false, reason: 'VWAP not ready' };

        const vwapNow = vw[vw.length - 1];
        const vwapPrev = vw[vw.length - 2];
        const prevCandle = candles[candles.length - 2];

        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const bodyPct = range > 0 ? body / range : 0;

        // Cross up: prior candle was below VWAP, current closes above with body
        const crossedUp = prevCandle.close < vwapPrev && last.close > vwapNow;
        // Cross down: prior was above, current closes below
        const crossedDn = prevCandle.close > vwapPrev && last.close < vwapNow;
        const decisive = bodyPct > 0.5;

        if (crossedUp) {
            return {
                fired: decisive,
                side: 'BUY_CALL',
                reason: decisive
                    ? `Price crossed above VWAP ${vwapNow.toFixed(2)} with body ${(bodyPct*100).toFixed(0)}%`
                    : `Crossed VWAP up but weak body (${(bodyPct*100).toFixed(0)}%)`,
                metrics: { vwap: vwapNow, bodyPct }
            };
        }
        if (crossedDn) {
            return {
                fired: decisive,
                side: 'BUY_PUT',
                reason: decisive
                    ? `Price crossed below VWAP ${vwapNow.toFixed(2)} with body ${(bodyPct*100).toFixed(0)}%`
                    : `Crossed VWAP down but weak body (${(bodyPct*100).toFixed(0)}%)`,
                metrics: { vwap: vwapNow, bodyPct }
            };
        }
        return { fired: false, reason: `no VWAP cross (price ${last.close > vwapNow ? 'above' : 'below'})` };
    }
};
