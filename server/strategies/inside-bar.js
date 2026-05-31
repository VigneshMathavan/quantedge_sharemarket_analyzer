// strategies/inside-bar.js — Inside Bar breakout.
//
// Inside bar = current candle's H<=prior H AND L>=prior L (range contained).
// Signals: when the NEXT candle breaks out of the inside bar's range with
// volume + body.
//
// Why it works: inside bars represent indecision. The breakout direction
// usually wins because the trapped energy explodes out one side.

export const insideBarStrategy = {
    id: 'inside_bar',
    name: 'Inside Bar Breakout',
    marketBias: 'any',
    weight: 14,

    detect({ candles, last }) {
        if (candles.length < 5) return { fired: false, reason: 'need 5+ candles' };
        // Looking at the SECOND-to-last candle: was it an inside bar relative to its predecessor?
        const c1 = candles[candles.length - 3];  // setup bar
        const c2 = candles[candles.length - 2];  // inside bar
        const c3 = last;                          // current — potential breakout

        const isInside = c2.high <= c1.high && c2.low >= c1.low;
        if (!isInside) {
            return { fired: false, reason: 'no inside-bar setup in last 2 candles' };
        }

        const range = c3.high - c3.low;
        const body = Math.abs(c3.close - c3.open);
        const bodyPct = range > 0 ? body / range : 0;

        // Breakout up: closes above inside-bar high with body
        const breakUp = c3.close > c2.high && c3.close > c3.open;
        // Breakout down: closes below inside-bar low with body
        const breakDn = c3.close < c2.low && c3.close < c3.open;
        const decisive = bodyPct > 0.55;

        if (breakUp) {
            return {
                fired: decisive,
                side: 'BUY_CALL',
                reason: decisive
                    ? `Inside-bar break ↑ above ${c2.high.toFixed(2)} (body ${(bodyPct*100).toFixed(0)}%)`
                    : `Above inside-bar but weak body (${(bodyPct*100).toFixed(0)}%)`,
                metrics: { innerHigh: c2.high, innerLow: c2.low, bodyPct }
            };
        }
        if (breakDn) {
            return {
                fired: decisive,
                side: 'BUY_PUT',
                reason: decisive
                    ? `Inside-bar break ↓ below ${c2.low.toFixed(2)} (body ${(bodyPct*100).toFixed(0)}%)`
                    : `Below inside-bar but weak body (${(bodyPct*100).toFixed(0)}%)`,
                metrics: { innerHigh: c2.high, innerLow: c2.low, bodyPct }
            };
        }
        return {
            fired: false,
            reason: `inside-bar formed (${c2.low.toFixed(2)}-${c2.high.toFixed(2)}), waiting for break`,
            metrics: { innerHigh: c2.high, innerLow: c2.low }
        };
    }
};
