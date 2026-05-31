// server/path-forecaster.js — Live inference of "what happens NEXT" after a trade entry.
//
// Trained on 5-yr 5-minute data (data/NIFTY_5minute.json etc). For every
// candle, we simulated a CALL and PUT entry at close, then scanned the next
// 12 candles (~1 hour) to label:
//   - outcome: T1_HIT / SL_HIT / TIME_OUT
//   - MFE / MAE in ATR units
//
// Live: extract the same features from current candles → score with the
// saved logistic + linear models → returns:
//   { pT1, pSL, pTimeout, expectedMfeAtr, expectedMaeAtr,
//     expectedMfePct, expectedMaePct, expectedDurationMin, confidence }
//
// If model file is missing, returns a heuristic baseline so the UI still works.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ema, rsi, atr } from './signal2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, '..', 'data', 'path-forecaster-model.json');
const RF_MODEL_PATH = path.join(__dirname, '..', 'data', 'path-forecaster-rf.json');

// Random Forest inference — predicts using bagged decision trees
function predictForestInline(forest, features) {
    let sum = 0;
    for (const tree of forest.trees) {
        let node = tree;
        while (!node.leaf) {
            node = (features[node.feat] <= node.thresh) ? node.left : node.right;
        }
        sum += node.value;
    }
    return sum / forest.trees.length;
}

// Feature extraction — MUST match training script exactly
export function extractFeatures(candles, tfMin = 5) {
    const n = candles.length;
    if (n < 50) return null;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const rsi14 = rsi(closes, 14);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const atr14 = atr(candles, 14);

    const last = candles[n - 1];
    const lastAtr = atr14[atr14.length - 1] || 1;
    const lastRsi = rsi14[rsi14.length - 1] || 50;
    const lastE20 = ema20[ema20.length - 1] || last.close;
    const lastE50 = ema50[ema50.length - 1] || last.close;

    const e20Slope = (lastE20 - (ema20[ema20.length - 4] || lastE20)) / lastAtr;
    const e50Slope = (lastE50 - (ema50[ema50.length - 4] || lastE50)) / lastAtr;
    const emaDist = (last.close - lastE20) / lastAtr;
    const ema2050 = (lastE20 - lastE50) / lastAtr;

    // ATR ratio (short / long) — bigger means volatility expanding
    const atrShort = atr(candles.slice(-10), 5);
    const atrShortLast = atrShort[atrShort.length - 1] || lastAtr;
    const atrRatio = atrShortLast / lastAtr;

    // Last-candle body/range, prev-3 direction
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low || 1;
    const bodyRatio = body / range;
    const rangePct = range / last.close;

    let prev3Dir = 0;
    for (let i = 1; i <= 3; i++) {
        const c = candles[n - i];
        if (c) prev3Dir += Math.sign(c.close - c.open);
    }
    prev3Dir /= 3;

    // Time of day (IST) — bucket
    const istMs = (last.time * 1000) + (5 * 60 + 30) * 60 * 1000;
    const istMin = Math.floor(istMs / 60000) % (24 * 60);
    const sessionMin = istMin - (9 * 60 + 15);  // minutes since open
    const sessionFrac = Math.max(0, Math.min(1, sessionMin / (6 * 60 + 15)));

    return {
        rsi: lastRsi,
        rsiNorm: (lastRsi - 50) / 50,
        e20Slope,
        e50Slope,
        emaDist,
        ema2050,
        atrRatio,
        bodyRatio,
        rangePct,
        prev3Dir,
        sessionFrac,
        atrAbs: lastAtr,
        closeAbs: last.close
    };
}

// Sigmoid for logistic regression
const sigmoid = z => 1 / (1 + Math.exp(-z));

function score(weights, intercept, features, keys) {
    let z = intercept;
    for (const k of keys) z += (weights[k] || 0) * (features[k] || 0);
    return z;
}

class PathForecaster {
    constructor() {
        this.model = null;
        this.rfModel = null;
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(MODEL_PATH)) {
                this.model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
                console.log(`[path-forecaster] logistic loaded — ${this.model.trainedOn} samples`);
            }
            if (fs.existsSync(RF_MODEL_PATH)) {
                this.rfModel = JSON.parse(fs.readFileSync(RF_MODEL_PATH, 'utf-8'));
                console.log(`[path-forecaster] Random Forest loaded — ${this.rfModel.trainedOn} samples · PRIMARY model`);
            }
            if (!this.model && !this.rfModel) {
                console.log('[path-forecaster] no model — heuristic baseline');
            }
        } catch (e) {
            console.error('[path-forecaster] load failed:', e.message);
        }
    }

    isReady() { return !!(this.model || this.rfModel); }

    // Live forecast — given current candles + intended side, returns probability map
    forecast({ candles, side, tfMin = 5 }) {
        if (!candles || candles.length < 50) return null;
        const f = extractFeatures(candles, tfMin);
        if (!f) return null;
        const sideKey = (side === 'BUY_PUT' || side === 'SELL_CALL') ? 'PUT' : 'CALL';

        // Prefer Random Forest model when available — gives +2-3% AUC over logistic
        if (this.rfModel && this.rfModel.sides[sideKey]) {
            return this._forecastRF(f, sideKey, tfMin);
        }
        if (!this.model || !this.model.sides[sideKey]) {
            return this._heuristic(f, sideKey);
        }

        const m = this.model.sides[sideKey];
        const keys = this.model.featureKeys;

        const pT1Raw = sigmoid(score(m.pT1.w, m.pT1.b, f, keys));
        const pSLRaw = sigmoid(score(m.pSL.w, m.pSL.b, f, keys));
        const pTORaw = sigmoid(score(m.pTimeout.w, m.pTimeout.b, f, keys));
        // Normalize to sum=1
        const sum = pT1Raw + pSLRaw + pTORaw || 1;
        const pT1 = pT1Raw / sum;
        const pSL = pSLRaw / sum;
        const pTO = pTORaw / sum;

        // Linear regressions for MFE/MAE (in ATR units)
        let mfeAtr = score(m.mfe.w, m.mfe.b, f, keys);
        let maeAtr = score(m.mae.w, m.mae.b, f, keys);
        mfeAtr = Math.max(0.1, mfeAtr);
        maeAtr = Math.max(0.1, maeAtr);

        const mfePct = (mfeAtr * f.atrAbs) / f.closeAbs * 100;
        const maePct = (maeAtr * f.atrAbs) / f.closeAbs * 100;

        // Confidence — entropy-based (lower entropy = higher confidence)
        const entropy = -([pT1, pSL, pTO].filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0));
        const maxEntropy = Math.log(3);
        const confidence = Math.round((1 - entropy / maxEntropy) * 100);

        // Verdict: hold or bail
        let verdict = 'NEUTRAL';
        if (pT1 > 0.55 && pT1 > pSL * 1.4) verdict = 'FAVORABLE';
        else if (pSL > 0.5 && pSL > pT1) verdict = 'UNFAVORABLE';
        else if (pTO > 0.55) verdict = 'CHOP';

        return {
            side: sideKey,
            pT1: parseFloat((pT1 * 100).toFixed(1)),
            pSL: parseFloat((pSL * 100).toFixed(1)),
            pTimeout: parseFloat((pTO * 100).toFixed(1)),
            expectedMfeAtr: parseFloat(mfeAtr.toFixed(2)),
            expectedMaeAtr: parseFloat(maeAtr.toFixed(2)),
            expectedMfePct: parseFloat(mfePct.toFixed(2)),
            expectedMaePct: parseFloat(maePct.toFixed(2)),
            expectedDurationMin: Math.round((this.model.lookaheadCandles || 12) * tfMin * 0.5),
            confidence,
            verdict,
            source: 'trained'
        };
    }

    // Random Forest inference path — used when rfModel is loaded
    _forecastRF(f, sideKey, tfMin) {
        const m = this.rfModel.sides[sideKey];
        const keys = this.rfModel.featureKeys;
        const featArr = keys.map(k => f[k] || 0);

        let pT1 = predictForestInline(m.pT1, featArr);
        let pSL = predictForestInline(m.pSL, featArr);
        // RF outputs probabilities directly (already 0-1), no sigmoid needed
        pT1 = Math.max(0, Math.min(1, pT1));
        pSL = Math.max(0, Math.min(1, pSL));
        // Timeout = whatever's left
        const pTO = Math.max(0, 1 - pT1 - pSL);
        const sum = pT1 + pSL + pTO || 1;
        const nT1 = pT1 / sum, nSL = pSL / sum, nTO = pTO / sum;

        const mfeAtr = Math.max(0.1, predictForestInline(m.mfe, featArr));
        const maeAtr = Math.max(0.1, predictForestInline(m.mae, featArr));
        const mfePct = (mfeAtr * f.atrAbs) / f.closeAbs * 100;
        const maePct = (maeAtr * f.atrAbs) / f.closeAbs * 100;

        const entropy = -([nT1, nSL, nTO].filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0));
        const confidence = Math.round((1 - entropy / Math.log(3)) * 100);

        let verdict = 'NEUTRAL';
        if (nT1 > 0.50 && nT1 > nSL * 1.3) verdict = 'FAVORABLE';
        else if (nSL > 0.50 && nSL > nT1 * 1.2) verdict = 'UNFAVORABLE';
        else if (nTO > 0.50) verdict = 'CHOP';

        return {
            side: sideKey,
            pT1: parseFloat((nT1 * 100).toFixed(1)),
            pSL: parseFloat((nSL * 100).toFixed(1)),
            pTimeout: parseFloat((nTO * 100).toFixed(1)),
            expectedMfeAtr: parseFloat(mfeAtr.toFixed(2)),
            expectedMaeAtr: parseFloat(maeAtr.toFixed(2)),
            expectedMfePct: parseFloat(mfePct.toFixed(2)),
            expectedMaePct: parseFloat(maePct.toFixed(2)),
            expectedDurationMin: Math.round((this.rfModel.lookaheadCandles || 12) * tfMin * 0.5),
            confidence,
            verdict,
            source: 'random-forest'
        };
    }

    // Fallback when model not yet trained — heuristic guesses
    _heuristic(f, sideKey) {
        const isCall = sideKey === 'CALL';
        // Bullish features for call: rsi 40-65, ema slope positive, body ratio good
        let bull = 0;
        bull += isCall ? f.rsiNorm * 0.5 : -f.rsiNorm * 0.5;
        bull += isCall ? f.e20Slope * 0.4 : -f.e20Slope * 0.4;
        bull += isCall ? f.prev3Dir * 0.3 : -f.prev3Dir * 0.3;
        bull += f.bodyRatio * 0.2;
        const pT1 = Math.max(0.15, Math.min(0.7, 0.4 + bull));
        const pSL = Math.max(0.15, Math.min(0.55, 0.35 - bull));
        const pTO = Math.max(0.1, 1 - pT1 - pSL);
        return {
            side: sideKey,
            pT1: Math.round(pT1 * 1000) / 10,
            pSL: Math.round(pSL * 1000) / 10,
            pTimeout: Math.round(pTO * 1000) / 10,
            expectedMfeAtr: 1.2,
            expectedMaeAtr: 1.0,
            expectedMfePct: parseFloat((1.2 * f.atrAbs / f.closeAbs * 100).toFixed(2)),
            expectedMaePct: parseFloat((1.0 * f.atrAbs / f.closeAbs * 100).toFixed(2)),
            expectedDurationMin: 30,
            confidence: 35,
            verdict: pT1 > 0.5 ? 'FAVORABLE' : pSL > 0.4 ? 'UNFAVORABLE' : 'NEUTRAL',
            source: 'heuristic'
        };
    }
}

export const pathForecaster = new PathForecaster();
