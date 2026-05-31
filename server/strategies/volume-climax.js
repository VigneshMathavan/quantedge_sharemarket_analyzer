// strategies/volume-climax.js — Volume climax reversal.
//
// When volume spikes 2x+ on a candle WITH a reversal-shaped candle (long
// wick, body opposite to recent direction), that's institutional exhaustion.
// The crowd capitulates and smart money takes the other side.
//
// Reversal direction: opposite of last 3 candles' direction.

export const volumeClimaxStrategy = {
    id: 'volume_climax',
    name: 'Volume Climax Reversal',
    marketBias: 'any',
    weight: 13,

    detect({ candles, last }) {
        if (candles.length < 15) return { fired: false, reason: 'insufficient history' };
        const prior10 = candles.slice(-11, -1);
        const avgVol = prior10.reduce((a, c) => a + c.volume, 0) / prior10.length;
        if (avgVol < 1) return { fired: false, reason: 'no volume data (index)' };
        const volMult = last.volume / avgVol;
        if (volMult < 2) {
            return { fired: false, reason: `vol ${volMult.toFixed(2)}× — no climax`, metrics: { volMult } };
        }

        // Recent direction: 3-candle close trend
        const last3 = candles.slice(-4, -1);
        const recentUp = last3.filter(c => c.close > c.open).length >= 2;
        const recentDn = last3.filter(c => c.close < c.open).length >= 2;

        // Candle structure: wick + reversal body
        const bodyTop = Math.max(last.open, last.close);
        const bodyBot = Math.min(last.open, last.close);
        const range = last.high - last.low;
        const upperWick = last.high - bodyTop;
        const lowerWick = bodyBot - last.low;

        // BULLISH reversal: recent was DOWN, this candle has long lower wick + closes up
        if (recentDn && lowerWick > range * 0.4 && last.close > last.open) {
            return {
                fired: true,
                side: 'BUY_CALL',
                reason: `Volume climax (${volMult.toFixed(2)}×) + bullish hammer (wick ${(lowerWick/range*100).toFixed(0)}%)`,
                metrics: { volMult, lowerWickPct: lowerWick / range }
            };
        }
        // BEARISH reversal
        if (recentUp && upperWick > range * 0.4 && last.close < last.open) {
            return {
                fired: true,
                side: 'BUY_PUT',
                reason: `Volume climax (${volMult.toFixed(2)}×) + bearish shooting star (wick ${(upperWick/range*100).toFixed(0)}%)`,
                metrics: { volMult, upperWickPct: upperWick / range }
            };
        }
        return { fired: false, reason: `vol spike ${volMult.toFixed(2)}× but no reversal candle structure` };
    }
};
