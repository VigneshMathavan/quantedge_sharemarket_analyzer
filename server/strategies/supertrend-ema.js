// strategies/supertrend-ema.js — Supertrend + EMA confluence
//
// Fires when:
//   1. Supertrend(10, 3) flips direction in the last 1-2 candles
//   2. EMA20 cross confirms direction (slope of last 5 EMA values)
//   3. Current candle has strong body relative to its range (decisive move)
//   4. Volume on the flip candle is above-average (institutional participation)
//
// This is the "I want to ride a clear regime change" entry.

import { atr } from '../signal2.js';

function supertrend(candles, period = 10, multiplier = 3) {
    const atrArr = atr(candles, period);
    if (atrArr.length === 0) return [];
    const out = [];
    let prevSt = null, prevDir = 1;
    for (let i = 0; i < atrArr.length; i++) {
        const ci = i + period;
        if (ci >= candles.length) break;
        const c = candles[ci];
        const hl2 = (c.high + c.low) / 2;
        const upper = hl2 + multiplier * atrArr[i];
        const lower = hl2 - multiplier * atrArr[i];
        let dir;
        if (prevSt === null) dir = c.close > upper ? 1 : -1;
        else if (prevDir === 1) dir = c.close < (prevSt) ? -1 : 1;
        else dir = c.close > (prevSt) ? 1 : -1;
        const st = dir === 1 ? lower : upper;
        out.push({ time: c.time, value: st, dir });
        prevSt = st; prevDir = dir;
    }
    return out;
}

export const supertrendEmaStrategy = {
    id: 'supertrend_ema',
    name: 'Supertrend + EMA Confluence',
    marketBias: 'trending',
    weight: 22,

    detect({ candles, indicators, last }) {
        const stSer = supertrend(candles, 10, 3);
        if (stSer.length < 3) return { fired: false, reason: 'Supertrend not ready' };
        const stNow = stSer[stSer.length - 1];
        const stPrev1 = stSer[stSer.length - 2];
        const stPrev2 = stSer[stSer.length - 3];

        // Need a recent direction flip (in last 1 or 2 candles)
        const flippedNow = stNow.dir !== stPrev1.dir;
        const flippedRecent = stPrev1.dir !== stPrev2.dir;
        if (!flippedNow && !flippedRecent) {
            return { fired: false, reason: `Supertrend stable ${stNow.dir === 1 ? 'bullish' : 'bearish'} — no fresh flip` };
        }

        const ema20V = indicators.ema20[indicators.ema20.length - 1];
        const ema20Prev = indicators.ema20[indicators.ema20.length - 5] ?? ema20V;
        const ema20Slope = (ema20V - ema20Prev) / ema20Prev * 100;

        // Candle quality
        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const bodyPct = range > 0 ? body / range : 0;
        const recentVolAvg = candles.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20 || 1;
        const volMult = last.volume / recentVolAvg;

        // BULLISH flip
        if (stNow.dir === 1 && ema20Slope > 0.02 && last.close > ema20V) {
            const decisive = bodyPct > 0.55;
            const volOk = volMult > 1.1;
            const fired = decisive && volOk;
            return {
                fired,
                side: 'BUY_CALL',
                reason: fired
                    ? `Supertrend flipped bullish, EMA20 slope +${ema20Slope.toFixed(2)}%, body ${(bodyPct * 100).toFixed(0)}%, vol ${volMult.toFixed(2)}×`
                    : !decisive ? `Bullish flip but weak body (${(bodyPct * 100).toFixed(0)}%)` : `Bullish flip but volume only ${volMult.toFixed(2)}×`,
                metrics: { stDir: 1, ema20Slope, bodyPct, volMult }
            };
        }

        // BEARISH flip
        if (stNow.dir === -1 && ema20Slope < -0.02 && last.close < ema20V) {
            const decisive = bodyPct > 0.55;
            const volOk = volMult > 1.1;
            const fired = decisive && volOk;
            return {
                fired,
                side: 'BUY_PUT',
                reason: fired
                    ? `Supertrend flipped bearish, EMA20 slope ${ema20Slope.toFixed(2)}%, body ${(bodyPct * 100).toFixed(0)}%, vol ${volMult.toFixed(2)}×`
                    : !decisive ? `Bearish flip but weak body (${(bodyPct * 100).toFixed(0)}%)` : `Bearish flip but volume only ${volMult.toFixed(2)}×`,
                metrics: { stDir: -1, ema20Slope, bodyPct, volMult }
            };
        }

        return { fired: false, reason: 'flip detected but EMA20 not confirming', metrics: { stDir: stNow.dir, ema20Slope } };
    }
};
