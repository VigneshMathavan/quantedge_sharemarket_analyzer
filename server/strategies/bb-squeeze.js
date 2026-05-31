// strategies/bb-squeeze.js — Bollinger Band squeeze breakout.
//
// Fires when:
//   • BB width has been very narrow for the last 6-10 candles (squeeze)
//   • Current candle breaks outside the bands with body confirming direction
//   • Volume on the breakout candle > recent average
//
// Why this works on ALL market types:
//   Volatility cycles. Periods of consolidation (low BB width) are followed
//   by expansion. The Bollinger squeeze is one of the most reliable patterns
//   in technical trading — caught BEFORE the move, not after.
//
// Calibration:
//   The "squeeze" threshold is dynamic — relative to the BB width over the
//   last 100 candles. If current width is in the bottom 20% of recent values,
//   it's a squeeze setup.

import { bollinger } from '../signal2.js';

export const bbSqueezeStrategy = {
    id: 'bb_squeeze',
    name: 'Bollinger Squeeze Breakout',
    marketBias: 'any',
    weight: 16,

    detect({ candles, indicators, last }) {
        const closes = candles.map(c => c.close);
        const bb = bollinger(closes, 20, 2);
        if (bb.length < 30) return { fired: false, reason: 'BB history insufficient' };

        const cur = bb[bb.length - 1];
        const recent = bb.slice(-30);
        const widths = recent.map(b => b.width);
        widths.sort((a, b) => a - b);
        const widthP20 = widths[Math.floor(widths.length * 0.2)];

        // Squeeze check: was the last 6-candle window in low-vol regime?
        const recent6Widths = bb.slice(-6, -1).map(b => b.width);
        const inSqueeze = recent6Widths.every(w => w <= widthP20 * 1.15);

        if (!inSqueeze) {
            return {
                fired: false,
                reason: `width ${(cur.width * 10000).toFixed(0)}bps not in recent squeeze zone`,
                metrics: { curWidth: cur.width, widthP20 }
            };
        }

        // Breakout direction
        const breakoutUp = last.close > cur.upper && last.close > last.open;
        const breakoutDn = last.close < cur.lower && last.close < last.open;
        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const bodyPct = range > 0 ? body / range : 0;
        const decisiveBody = bodyPct > 0.5;

        const volAvg = candles.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20 || 1;
        const volMult = last.volume / volAvg;
        const volOk = volMult > 1.1;

        if (breakoutUp) {
            const fired = decisiveBody && volOk;
            return {
                fired,
                side: 'BUY_CALL',
                reason: fired
                    ? `Squeeze break ↑ above BB upper, body ${(bodyPct * 100).toFixed(0)}%, vol ${volMult.toFixed(2)}×`
                    : `Above BB upper but weak ${!decisiveBody ? 'body' : 'volume'}`,
                metrics: { bbUpper: cur.upper, bodyPct, volMult }
            };
        }

        if (breakoutDn) {
            const fired = decisiveBody && volOk;
            return {
                fired,
                side: 'BUY_PUT',
                reason: fired
                    ? `Squeeze break ↓ below BB lower, body ${(bodyPct * 100).toFixed(0)}%, vol ${volMult.toFixed(2)}×`
                    : `Below BB lower but weak ${!decisiveBody ? 'body' : 'volume'}`,
                metrics: { bbLower: cur.lower, bodyPct, volMult }
            };
        }

        return {
            fired: false,
            reason: `squeeze active but inside bands (${cur.lower.toFixed(2)}-${cur.upper.toFixed(2)})`,
            metrics: { close: last.close, bbLower: cur.lower, bbUpper: cur.upper }
        };
    }
};
