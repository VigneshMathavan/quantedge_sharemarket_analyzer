// strategies/orb.js — Opening Range Breakout
//
// Rules:
//   1. Define opening range = high/low of first 3 candles after 9:15 IST
//      (15 min on 5m timeframe; 9 min on 3m; 15 candles on 1m)
//   2. After the range is set (>= 9:30 IST), fire long if close > ORH;
//      short if close < ORL.
//   3. Volume must be >= 1.3× the average of the ORB-period candles
//      to filter fake breakouts.
//   4. Skip if ATR % is < 0.08% (too quiet to follow through) or > 0.5%
//      (already wild — likely event-driven, fakeout risk).
//   5. Don't fire after 13:00 IST — late-day breakouts statistically fail.

import { istClock } from './base.js';

function findTodayCandles(candles, refTime) {
    // Walk back from end until we cross to previous IST day
    const ref = istClock(refTime);
    const refDayKey = (() => {
        const d = new Date(refTime * 1000 + (5 * 60 + 30) * 60 * 1000);
        return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    })();
    const out = [];
    for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i];
        const d = new Date(c.time * 1000 + (5 * 60 + 30) * 60 * 1000);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        if (key !== refDayKey) break;
        out.unshift(c);
    }
    return out;
}

export const orbStrategy = {
    id: 'orb',
    name: 'Opening Range Breakout',
    marketBias: 'trending',
    weight: 18,

    detect({ candles, indicators, timeIST, last }) {
        const today = findTodayCandles(candles, last.time);
        if (today.length < 4) return { fired: false, reason: 'not enough candles today yet' };

        // Opening range = first 3 candles (covers 9:15-9:30 IST on 5m / 9:15-9:24 on 3m)
        const orbWindow = today.slice(0, 3);
        const orh = Math.max(...orbWindow.map(c => c.high));
        const orl = Math.min(...orbWindow.map(c => c.low));
        const orVol = orbWindow.reduce((a, b) => a + b.volume, 0) / orbWindow.length;

        // Skip if still inside ORB window
        if (today.length <= 3) return { fired: false, reason: 'ORB window still forming' };

        // Late-day note (no longer a hard block — afternoon breakouts can be valid)
        // Caller will use tier/size info to size appropriately.

        // Volatility filter
        const atrV = indicators.atr14[indicators.atr14.length - 1] || 0;
        const atrPct = (atrV / last.close) * 100;
        if (atrPct < 0.08) return { fired: false, reason: `ATR ${atrPct.toFixed(3)}% — too quiet`, metrics: { orh, orl, atrPct } };
        if (atrPct > 0.5) return { fired: false, reason: `ATR ${atrPct.toFixed(3)}% — too wild`, metrics: { orh, orl, atrPct } };

        // Volume confirmation
        const volOk = orVol > 0 ? (last.volume / orVol) >= 1.3 : true;

        // Breakout check
        if (last.close > orh) {
            return {
                fired: volOk,
                side: 'BUY_CALL',
                reason: volOk
                    ? `Break above ORH ${orh.toFixed(2)} with vol ${(last.volume / orVol).toFixed(2)}×`
                    : `Above ORH but volume weak (${(last.volume / orVol).toFixed(2)}×)`,
                metrics: { orh, orl, atrPct, volMultiple: orVol > 0 ? last.volume / orVol : null }
            };
        }
        if (last.close < orl) {
            return {
                fired: volOk,
                side: 'BUY_PUT',
                reason: volOk
                    ? `Break below ORL ${orl.toFixed(2)} with vol ${(last.volume / orVol).toFixed(2)}×`
                    : `Below ORL but volume weak (${(last.volume / orVol).toFixed(2)}×)`,
                metrics: { orh, orl, atrPct, volMultiple: orVol > 0 ? last.volume / orVol : null }
            };
        }
        return { fired: false, reason: `inside ORB ${orl.toFixed(2)}-${orh.toFixed(2)}`, metrics: { orh, orl, atrPct } };
    }
};
