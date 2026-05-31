// strategies/momentum-burst.js — Catches FRESH directional moves.
//
// Existing strategies all need history/setup/confirmation. This one fires
// when the CURRENT candle is itself a momentum signal — large directional
// body + volume + range above recent average. Catches gap-down sell-offs,
// breakaway moves, and the first big push after consolidation.
//
// Fires when ALL of these are true:
//   • Body size > 1.7x the avg body of last 10 candles
//   • Candle range > 1.4x avg range of last 10 candles
//   • Volume > 1.3x avg volume of last 10 candles
//   • Body % of range > 60% (decisive, not a wick)
//   • Net move from prior close > 0.10% (real magnitude)
//
// Direction = candle close vs candle open.

export const momentumBurstStrategy = {
    id: 'momentum_burst',
    name: 'Momentum Burst',
    marketBias: 'any',
    weight: 24,  // higher than others — this is "the move is happening RIGHT NOW"

    detect({ candles, last }) {
        if (candles.length < 12) return { fired: false, reason: 'insufficient history' };

        // Skip candle #1 of the day — opening prints are unreliable (overnight unwind)
        const lastIst = new Date((last.time + 5.5 * 3600) * 1000);
        if (lastIst.getUTCHours() === 9 && lastIst.getUTCMinutes() < 20) {
            return { fired: false, reason: 'first candle of session — wait for direction confirmation' };
        }

        const prior = candles.slice(-11, -1);  // last 10 candles BEFORE current
        const avgBody = prior.reduce((a, c) => a + Math.abs(c.close - c.open), 0) / prior.length;
        const avgRange = prior.reduce((a, c) => a + (c.high - c.low), 0) / prior.length;
        const avgVol = prior.reduce((a, c) => a + c.volume, 0) / prior.length;

        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const bodyOfRange = range > 0 ? body / range : 0;
        const bodyMult = avgBody > 0 ? body / avgBody : 0;
        const rangeMult = avgRange > 0 ? range / avgRange : 0;
        const volMult = avgVol > 0 ? last.volume / avgVol : 1;  // 1 if avg vol is 0 (e.g. cached data)

        const prevClose = prior[prior.length - 1].close;
        const netMovePct = Math.abs(last.close - prevClose) / prevClose * 100;

        // For data sources without volume (Yahoo for indices), waive the volume check
        // and rely on body + range instead
        const hasVolume = avgVol > 100;
        const volOk = !hasVolume || volMult > 1.3;

        const decisive = bodyOfRange > 0.6;
        const bodyBurst = bodyMult > 1.7;
        const rangeBurst = rangeMult > 1.4;
        const magnitudeOk = netMovePct > 0.10;

        const allOK = decisive && bodyBurst && rangeBurst && magnitudeOk && volOk;

        const direction = last.close > last.open ? 'BUY_CALL' : 'BUY_PUT';

        // Build reason string showing exactly which conditions met / failed
        const checks = [
            decisive ? `body/range ${(bodyOfRange*100).toFixed(0)}%✓` : `body/range ${(bodyOfRange*100).toFixed(0)}%✗(<60%)`,
            bodyBurst ? `body ${bodyMult.toFixed(2)}×✓` : `body ${bodyMult.toFixed(2)}×✗(<1.7)`,
            rangeBurst ? `range ${rangeMult.toFixed(2)}×✓` : `range ${rangeMult.toFixed(2)}×✗(<1.4)`,
            magnitudeOk ? `move ${netMovePct.toFixed(2)}%✓` : `move ${netMovePct.toFixed(2)}%✗(<0.10%)`,
            hasVolume ? (volOk ? `vol ${volMult.toFixed(2)}×✓` : `vol ${volMult.toFixed(2)}×✗(<1.3)`) : 'vol n/a'
        ].join(' · ');

        return {
            fired: allOK,
            side: direction,
            reason: allOK
                ? `🚀 Momentum burst ${last.close > last.open ? '↑' : '↓'} ${netMovePct.toFixed(2)}%  ·  ${checks}`
                : checks,
            metrics: { bodyOfRange, bodyMult, rangeMult, volMult, netMovePct, hasVolume }
        };
    }
};
