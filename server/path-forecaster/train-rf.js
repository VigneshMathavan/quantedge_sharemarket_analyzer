// server/path-forecaster/train-rf.js — Train Random Forest forecaster on 10yr data.
//
// Output: data/path-forecaster-rf.json — same shape as logistic model but with
// "rf" field per side containing tree ensemble. The path-forecaster runtime
// auto-detects the new format and uses it preferentially.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { atr } from '../signal2.js';
import { extractFeatures } from '../path-forecaster.js';
import { trainRandomForest, predictForest, aucForest } from './random-forest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HIST_DIR = path.join(DATA_DIR, 'historical');
const OUT_PATH = path.join(DATA_DIR, 'path-forecaster-rf.json');

const SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'];
const TF_MIN = 5;
const LOOKAHEAD = 12;
const SL_ATR_MULT = 1.5;
const T1_ATR_MULT = 1.2;

const FEATURE_KEYS = [
    'rsiNorm', 'e20Slope', 'e50Slope', 'emaDist', 'ema2050',
    'atrRatio', 'bodyRatio', 'rangePct', 'prev3Dir', 'sessionFrac'
];

function loadAndResample(symbol) {
    // Prefer NATIVE 5min Upstox data (cleanest); fall back to resampling 1min;
    // last resort, the original 5yr data folder.
    const native5 = path.join(HIST_DIR, `${symbol}_5minute.json`);
    if (fs.existsSync(native5)) {
        const arr = JSON.parse(fs.readFileSync(native5, 'utf-8'));
        if (arr.length > 1000) return arr;
    }
    const histPath = path.join(HIST_DIR, `${symbol}_1minute.json`);
    if (fs.existsSync(histPath)) {
        const raw = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
        if (raw.length > 1000) return resampleTo5Min(raw);
    }
    const oldPath = path.join(DATA_DIR, `${symbol}_5minute.json`);
    if (fs.existsSync(oldPath)) return JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
    return null;
}

function resampleTo5Min(oneMin) {
    if (!oneMin?.length) return [];
    const out = [];
    let bucket = null;
    for (const c of oneMin) {
        const start = Math.floor(c.time / 300) * 300;
        if (!bucket || bucket.time !== start) {
            if (bucket) out.push(bucket);
            bucket = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
        } else {
            bucket.high = Math.max(bucket.high, c.high);
            bucket.low = Math.min(bucket.low, c.low);
            bucket.close = c.close;
            bucket.volume = (bucket.volume || 0) + (c.volume || 0);
        }
    }
    if (bucket) out.push(bucket);
    return out;
}

function labelEntry(candles, i, atrAt, side) {
    const entry = candles[i].close;
    const isCall = side === 'CALL';
    const direction = isCall ? 1 : -1;
    const slPrice = isCall ? entry - atrAt * SL_ATR_MULT : entry + atrAt * SL_ATR_MULT;
    const t1Price = isCall ? entry + atrAt * T1_ATR_MULT : entry - atrAt * T1_ATR_MULT;
    let mfe = 0, mae = 0;
    let outcome = 'TIMEOUT';
    for (let k = 1; k <= LOOKAHEAD && i + k < candles.length; k++) {
        const c = candles[i + k];
        const favHigh = isCall ? c.high : -c.low;
        const advLow  = isCall ? c.low  : -c.high;
        const favMove = (favHigh - direction * entry) * direction;
        const advMove = -(advLow - direction * entry) * direction;
        if (favMove > mfe) mfe = favMove;
        if (advMove > mae) mae = advMove;
        const touchSL = isCall ? c.low <= slPrice : c.high >= slPrice;
        const touchT1 = isCall ? c.high >= t1Price : c.low <= t1Price;
        if (touchSL) { outcome = 'SL'; break; }
        if (touchT1) { outcome = 'T1'; break; }
    }
    return { outcome, mfeAtr: mfe / atrAt, maeAtr: mae / atrAt };
}

function featuresToArray(f) {
    return FEATURE_KEYS.map(k => f[k] || 0);
}

function buildSamples(symbol, candles) {
    if (!candles || candles.length < 100) return [];
    const samples = [];
    const atr14 = atr(candles, 14);
    for (let i = 60; i < candles.length - LOOKAHEAD - 1; i++) {
        const window = candles.slice(Math.max(0, i - 220), i + 1);
        const atrAt = atr14[i] || 1;
        if (atrAt <= 0) continue;
        const f = extractFeatures(window, TF_MIN);
        if (!f) continue;
        const range = candles[i].high - candles[i].low;
        if (range / candles[i].close < 0.0003) continue;
        const fArr = featuresToArray(f);
        for (const side of ['CALL', 'PUT']) {
            samples.push({ f: fArr, side, ...labelEntry(candles, i, atrAt, side) });
        }
    }
    return samples;
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Random Forest Forecaster — Training on 10yr 1m data');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let allSamples = [];
    for (const sym of SYMBOLS) {
        const candles = loadAndResample(sym);
        if (!candles) { console.log(`  ⊘ ${sym}: missing`); continue; }
        console.log(`  • ${sym}: ${candles.length.toLocaleString()} candles`);
        const s = buildSamples(sym, candles);
        console.log(`    → ${s.length.toLocaleString()} samples`);
        allSamples = allSamples.concat(s);
    }
    console.log(`\n  Total: ${allSamples.length.toLocaleString()} labelled samples`);

    // Shuffle + 80/20 split
    for (let i = allSamples.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allSamples[i], allSamples[j]] = [allSamples[j], allSamples[i]];
    }
    const cut = Math.floor(allSamples.length * 0.8);
    const train = allSamples.slice(0, cut);
    const valid = allSamples.slice(cut);
    console.log(`  Train: ${train.length.toLocaleString()}  Valid: ${valid.length.toLocaleString()}\n`);

    const model = {
        type: 'random-forest',
        trainedAt: new Date().toISOString(),
        trainedOn: train.length,
        featureKeys: FEATURE_KEYS,
        lookaheadCandles: LOOKAHEAD,
        slAtrMult: SL_ATR_MULT,
        t1AtrMult: T1_ATR_MULT,
        sides: {},
        validation: {}
    };

    // Compare against logistic AUC if available
    const logisticPath = path.join(DATA_DIR, 'path-forecaster-model.json');
    let logistic = null;
    if (fs.existsSync(logisticPath)) {
        try { logistic = JSON.parse(fs.readFileSync(logisticPath, 'utf-8')); } catch (_) {}
    }

    for (const side of ['CALL', 'PUT']) {
        const trainS = train.filter(s => s.side === side);
        const validS = valid.filter(s => s.side === side);
        console.log(`━━━ ${side} ━━━  train=${trainS.length.toLocaleString()}  valid=${validS.length.toLocaleString()}`);

        console.log('  Training pT1 RF (50 trees, depth 6)...');
        const pT1Rf = trainRandomForest(trainS, {
            labelKey: s => s.outcome === 'T1' ? 1 : 0,
            featureCount: FEATURE_KEYS.length,
            nTrees: 50, maxDepth: 6
        });
        const aucT1 = aucForest(validS, pT1Rf, s => s.outcome === 'T1');

        console.log('\n  Training pSL RF...');
        const pSLRf = trainRandomForest(trainS, {
            labelKey: s => s.outcome === 'SL' ? 1 : 0,
            featureCount: FEATURE_KEYS.length,
            nTrees: 50, maxDepth: 6
        });
        const aucSL = aucForest(validS, pSLRf, s => s.outcome === 'SL');

        console.log('\n  Training MFE/MAE regression RFs...');
        const mfeRf = trainRandomForest(trainS, {
            labelKey: s => Math.min(s.mfeAtr, 5),
            featureCount: FEATURE_KEYS.length,
            nTrees: 30, maxDepth: 6
        });
        const maeRf = trainRandomForest(trainS, {
            labelKey: s => Math.min(s.maeAtr, 5),
            featureCount: FEATURE_KEYS.length,
            nTrees: 30, maxDepth: 6
        });

        model.sides[side] = { pT1: pT1Rf, pSL: pSLRf, mfe: mfeRf, mae: maeRf };

        let oldAucT1 = null, oldAucSL = null;
        if (logistic?.sides?.[side]) {
            const sigmoid = z => 1 / (1 + Math.exp(-z));
            const scoreLogistic = (model, features) => {
                let z = model.b;
                for (let i = 0; i < FEATURE_KEYS.length; i++) z += (model.w[FEATURE_KEYS[i]] || 0) * features[i];
                return sigmoid(z);
            };
            const aucLog = (samples, model, isPosFn) => {
                const ranked = samples
                    .map(s => ({ p: scoreLogistic(model, s.f), y: isPosFn(s) ? 1 : 0 }))
                    .sort((a, b) => a.p - b.p);
                let nPos = 0, nNeg = 0, rankSum = 0;
                ranked.forEach((r, i) => { if (r.y) { nPos++; rankSum += (i + 1); } else nNeg++; });
                if (nPos === 0 || nNeg === 0) return 0.5;
                return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
            };
            oldAucT1 = aucLog(validS, logistic.sides[side].pT1, s => s.outcome === 'T1');
            oldAucSL = aucLog(validS, logistic.sides[side].pSL, s => s.outcome === 'SL');
        }

        model.validation[side] = {
            rfAucT1: aucT1, rfAucSL: aucSL,
            logisticAucT1: oldAucT1, logisticAucSL: oldAucSL,
            improvement: oldAucT1 !== null ? {
                t1Delta: aucT1 - oldAucT1, slDelta: aucSL - oldAucSL,
                t1DeltaPct: ((aucT1 / oldAucT1 - 1) * 100).toFixed(1) + '%'
            } : null
        };
        console.log(`\n  ${side} validation:`);
        console.log(`    RF P(T1) AUC:  ${aucT1.toFixed(4)}`);
        console.log(`    RF P(SL) AUC:  ${aucSL.toFixed(4)}`);
        if (oldAucT1) {
            const d1 = ((aucT1 - oldAucT1) * 100).toFixed(2);
            const d2 = ((aucSL - oldAucSL) * 100).toFixed(2);
            console.log(`    Logistic P(T1) AUC: ${oldAucT1.toFixed(4)}  Δ ${d1 > 0 ? '+' : ''}${d1}%`);
            console.log(`    Logistic P(SL) AUC: ${oldAucSL.toFixed(4)}  Δ ${d2 > 0 ? '+' : ''}${d2}%`);
        }
        console.log('');
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(model));
    const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✓ RF model saved → ${OUT_PATH} (${sizeMb}MB)`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => { console.error(e); process.exit(1); });
