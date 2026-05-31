// server/regime-engine.js — 8-class Market Regime Classifier
//
// V2 spec regimes:
//   TRENDING_BULL · TRENDING_BEAR · RANGE · BREAKOUT
//   HIGH_VOL · LOW_VOL · LUNCH_CHOP · EVENT_DRIVEN
//
// Inputs: recent candles (≥60), optional eventGate
// Outputs:
//   { regime, confidence, scores: {...}, sub: {...}, displayLabel, color }
//
// "Reject all trades" if confidence < 0.45 — handled upstream.

import { ema, rsi, atr, vwap } from './signal2.js';

function adx(candles, period = 14) {
    // Welles Wilder ADX — full implementation
    const tr = [];
    const pdm = [], ndm = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        const upMove = c.high - p.high;
        const downMove = p.low - c.low;
        pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
        ndm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    function smooth(arr, n) {
        const out = [];
        let prev = arr.slice(0, n).reduce((a, b) => a + b, 0);
        out[n - 1] = prev;
        for (let i = n; i < arr.length; i++) {
            prev = prev - prev / n + arr[i];
            out[i] = prev;
        }
        return out;
    }
    const trSm = smooth(tr, period);
    const pdmSm = smooth(pdm, period);
    const ndmSm = smooth(ndm, period);
    const pDI = [], nDI = [], dx = [];
    for (let i = period - 1; i < trSm.length; i++) {
        if (trSm[i] === 0) continue;
        const p = 100 * pdmSm[i] / trSm[i];
        const n = 100 * ndmSm[i] / trSm[i];
        pDI.push(p); nDI.push(n);
        dx.push(100 * Math.abs(p - n) / (p + n || 1));
    }
    const adxArr = smooth(dx, period).map(v => v / period);
    return { adx: adxArr, pDI, nDI };
}

export function classifyRegime({ candles, eventGate = null }) {
    if (!candles || candles.length < 60) {
        return { regime: 'UNCLEAR', confidence: 0, displayLabel: 'Unclear · No Data', color: 'gray' };
    }

    const n = candles.length;
    const closes = candles.map(c => c.close);
    const last = candles[n - 1];

    // --- Indicators ---
    const { adx: adxSer, pDI, nDI } = adx(candles, 14);
    const adxV = adxSer[adxSer.length - 1] || 0;
    const pDiV = pDI[pDI.length - 1] || 0;
    const nDiV = nDI[nDI.length - 1] || 0;

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const e20 = ema20[ema20.length - 1] || last.close;
    const e50 = ema50[ema50.length - 1] || last.close;
    const e20Slope = (e20 - (ema20[ema20.length - 5] || e20));
    const e20Prev = ema20[ema20.length - 6] || e20;

    const atr14 = atr(candles, 14);
    const atrV = atr14[atr14.length - 1] || 1;
    const atrAvg = atr14.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atr14.length);
    const atrRatio = atrV / (atrAvg || atrV);  // >1.3 = volatility expansion

    // Last 20-candle range vs avg
    const last20 = candles.slice(-20);
    const range20 = Math.max(...last20.map(c => c.high)) - Math.min(...last20.map(c => c.low));
    const last60 = candles.slice(-60);
    const range60 = Math.max(...last60.map(c => c.high)) - Math.min(...last60.map(c => c.low));
    const rangeContraction = range20 / (range60 || range20);  // <0.4 = tight

    // Volume signal
    const vols = candles.map(c => c.volume || 0);
    const volAvg20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20 || 1;
    const volNow = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const volRatio = volNow / volAvg20;

    // Last candle breakout magnitude
    const breakoutPct = Math.abs(last.close - e20) / e20 * 100;

    // Time of day (IST)
    const istMs = (last.time * 1000) + (5 * 60 + 30) * 60 * 1000;
    const istMin = Math.floor(istMs / 60000) % (24 * 60);
    const inLunchWindow = istMin >= (12 * 60) && istMin <= (13 * 60 + 30);

    // --- Regime votes ---
    const scores = {
        TRENDING_BULL: 0,
        TRENDING_BEAR: 0,
        RANGE: 0,
        BREAKOUT: 0,
        HIGH_VOL: 0,
        LOW_VOL: 0,
        LUNCH_CHOP: 0,
        EVENT_DRIVEN: 0
    };

    // Trending: ADX > 22 + EMA stack
    if (adxV > 22 && pDiV > nDiV && e20 > e50 && e20Slope > 0) {
        scores.TRENDING_BULL += 50 + Math.min(30, adxV - 22) * 1.0;
    }
    if (adxV > 22 && nDiV > pDiV && e20 < e50 && e20Slope < 0) {
        scores.TRENDING_BEAR += 50 + Math.min(30, adxV - 22) * 1.0;
    }

    // Range: ADX < 18 + tight range
    if (adxV < 18 && rangeContraction > 0.55) {
        scores.RANGE += 40 + (18 - adxV) * 2;
    }

    // Breakout: ATR ratio expanding + price > 20EMA by ATR + last 3 same direction
    const last3Dir = candles.slice(-3).reduce((s, c) => s + Math.sign(c.close - c.open), 0);
    if (atrRatio > 1.25 && breakoutPct > 0.15 && Math.abs(last3Dir) >= 2) {
        scores.BREAKOUT += 45 + (atrRatio - 1.25) * 30;
    }

    // High Vol: ATR ratio > 1.4
    if (atrRatio > 1.4) {
        scores.HIGH_VOL += 30 + (atrRatio - 1.4) * 40;
    }
    // Low Vol: ATR ratio < 0.75 AND tight range
    if (atrRatio < 0.75 && rangeContraction < 0.4) {
        scores.LOW_VOL += 35 + (0.75 - atrRatio) * 60;
    }

    // Lunch chop label kept for transparency — but scored low so it rarely
    // dominates. Global session overlaps (London open 12:30 IST, US pre-market
    // 14:00 IST) often inject fresh volume in this window.
    if (inLunchWindow && atrRatio < 0.8 && rangeContraction < 0.35) {
        scores.LUNCH_CHOP += 25;  // only labels when REALLY dead
    }

    // Event driven: explicit eventGate OR vol spike + news flag
    if (eventGate?.blocked || eventGate?.upcoming?.minutesAway < 60) {
        scores.EVENT_DRIVEN += 70;
    }
    if (atrRatio > 1.8) scores.EVENT_DRIVEN += 20;

    // --- Winner ---
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [regime, topScore] = sorted[0];
    const [, secondScore] = sorted[1];
    const margin = topScore - secondScore;
    const confidence = topScore <= 0 ? 0 : Math.min(1, (topScore / 100) * (0.5 + margin / 100));

    const labelMap = {
        TRENDING_BULL: '↑ Trending Bull',
        TRENDING_BEAR: '↓ Trending Bear',
        RANGE: '↔ Range Bound',
        BREAKOUT: '⚡ Breakout',
        HIGH_VOL: '🔥 High Volatility',
        LOW_VOL: '· Low Volatility',
        LUNCH_CHOP: '🥱 Lunch Chop',
        EVENT_DRIVEN: '📅 Event Driven',
        UNCLEAR: '? Unclear'
    };
    const colorMap = {
        TRENDING_BULL: 'green', TRENDING_BEAR: 'red',
        RANGE: 'gray', BREAKOUT: 'amber',
        HIGH_VOL: 'red', LOW_VOL: 'gray',
        LUNCH_CHOP: 'gray', EVENT_DRIVEN: 'red',
        UNCLEAR: 'gray'
    };

    const final = confidence < 0.4 ? 'UNCLEAR' : regime;
    return {
        regime: final,
        confidence: Math.round(confidence * 100),
        scores,
        sub: { adx: +adxV.toFixed(1), pDI: +pDiV.toFixed(1), nDI: +nDiV.toFixed(1),
               atrRatio: +atrRatio.toFixed(2), rangeContraction: +rangeContraction.toFixed(2),
               volRatio: +volRatio.toFixed(2), e20: +e20.toFixed(2), e50: +e50.toFixed(2),
               breakoutPct: +breakoutPct.toFixed(2), inLunchWindow },
        displayLabel: labelMap[final],
        color: colorMap[final]
    };
}

// Strategy ↔ Regime compatibility matrix (V2 Rule 3)
export const STRATEGY_REGIME_MATRIX = {
    orb:                  ['TRENDING_BULL', 'TRENDING_BEAR', 'BREAKOUT'],
    vwap_continuation:    ['TRENDING_BULL', 'TRENDING_BEAR'],
    supertrend_ema:       ['TRENDING_BULL', 'TRENDING_BEAR', 'BREAKOUT'],
    rsi_reversion:        ['RANGE', 'LOW_VOL'],
    bb_squeeze:           ['LOW_VOL', 'BREAKOUT'],
    momentum_burst:       ['TRENDING_BULL', 'TRENDING_BEAR', 'BREAKOUT', 'HIGH_VOL'],
    range_expansion:      ['BREAKOUT', 'HIGH_VOL'],
    inside_bar:           ['LOW_VOL', 'RANGE', 'BREAKOUT'],
    vwap_cross:           ['TRENDING_BULL', 'TRENDING_BEAR'],
    ema_pullback:         ['TRENDING_BULL', 'TRENDING_BEAR'],
    volume_climax:        ['HIGH_VOL', 'EVENT_DRIVEN', 'BREAKOUT'],
    cpr_breakout:         ['TRENDING_BULL', 'TRENDING_BEAR', 'BREAKOUT'],
    cpr_reversal:         ['RANGE', 'LUNCH_CHOP']
};

export function isStrategyCompatibleWithRegime(strategyId, regime) {
    const allowed = STRATEGY_REGIME_MATRIX[strategyId];
    if (!allowed) return true;  // unknown strategy → allow (don't block by default)
    return allowed.includes(regime);
}
