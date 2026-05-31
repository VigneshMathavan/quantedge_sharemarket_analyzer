// server/path-forecaster/train-10yr.js — Retrain on 10-year 1min Upstox data.
//
// Improvements over the original 5min trainer:
//   • 1-min data → 5x more samples
//   • Resamples to 5-min internally to keep feature parity
//   • Compares new model against old via held-out validation set
//   • Reports efficiency delta

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ema, rsi, atr } from '../signal2.js';
import { extractFeatures } from '../path-forecaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HIST_DIR = path.join(DATA_DIR, 'historical');
const OUT_PATH = path.join(DATA_DIR, 'path-forecaster-model.json');
const OLD_BACKUP = path.join(DATA_DIR, 'path-forecaster-model-5yr.json');

const SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'];
const TF_MIN = 5;
const LOOKAHEAD = 12;
const SL_ATR_MULT = 1.5;
const T1_ATR_MULT = 1.2;

const FEATURE_KEYS = [
    'rsiNorm', 'e20Slope', 'e50Slope', 'emaDist', 'ema2050',
    'atrRatio', 'bodyRatio', 'rangePct', 'prev3Dir', 'sessionFrac'
];

// Load 1-min and resample to 5-min for consistency with the original feature pipeline
function loadAndResample(symbol) {
    // Prefer the new 10yr 1min Upstox data
    const histPath = path.join(HIST_DIR, `${symbol}_1minute.json`);
    if (fs.existsSync(histPath)) {
        const raw = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
        return resampleTo5Min(raw);
    }
    // Fall back to original 5min data
    const oldPath = path.join(DATA_DIR, `${symbol}_5minute.json`);
    if (fs.existsSync(oldPath)) return JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
    return null;
}

function resampleTo5Min(oneMin) {
    if (!oneMin?.length) return [];
    const out = [];
    let bucket = null;
    for (const c of oneMin) {
        const bucketStart = Math.floor(c.time / 300) * 300;
        if (!bucket || bucket.time !== bucketStart) {
            if (bucket) out.push(bucket);
            bucket = { time: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
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
        for (const side of ['CALL', 'PUT']) {
            samples.push({ features: f, side, ...labelEntry(candles, i, atrAt, side) });
        }
    }
    return samples;
}

function trainLogistic(samples, getY, epochs = 80) {
    const w = {}; let b = 0;
    for (const k of FEATURE_KEYS) w[k] = 0;
    const lr = 0.05;
    const N = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
        const gW = {}; for (const k of FEATURE_KEYS) gW[k] = 0;
        let gB = 0;
        for (const s of samples) {
            let z = b; for (const k of FEATURE_KEYS) z += w[k] * (s.features[k] || 0);
            const p = 1 / (1 + Math.exp(-z));
            const err = p - getY(s);
            for (const k of FEATURE_KEYS) gW[k] += err * (s.features[k] || 0);
            gB += err;
        }
        for (const k of FEATURE_KEYS) w[k] -= (lr / N) * gW[k];
        b -= (lr / N) * gB;
    }
    return { w, b };
}

function trainLinear(samples, getY, epochs = 80) {
    const w = {}; let b = 0;
    for (const k of FEATURE_KEYS) w[k] = 0;
    const lr = 0.02;
    const N = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
        const gW = {}; for (const k of FEATURE_KEYS) gW[k] = 0;
        let gB = 0;
        for (const s of samples) {
            let z = b; for (const k of FEATURE_KEYS) z += w[k] * (s.features[k] || 0);
            const err = z - getY(s);
            for (const k of FEATURE_KEYS) gW[k] += err * (s.features[k] || 0);
            gB += err;
        }
        for (const k of FEATURE_KEYS) w[k] -= (lr / N) * gW[k];
        b -= (lr / N) * gB;
    }
    return { w, b };
}

// AUC: probability that a random WIN scores higher than a random LOSS
function auc(samples, model, isWinFn) {
    const scores = samples.map(s => {
        let z = model.b;
        for (const k of FEATURE_KEYS) z += (model.w[k] || 0) * (s.features[k] || 0);
        return { p: 1 / (1 + Math.exp(-z)), y: isWinFn(s) ? 1 : 0 };
    });
    scores.sort((a, b) => a.p - b.p);
    let totalPos = 0, totalNeg = 0, cumPos = 0, rankSum = 0;
    scores.forEach((s, i) => {
        if (s.y === 1) { totalPos++; cumPos++; rankSum += (i + 1); }
        else totalNeg++;
    });
    if (totalPos === 0 || totalNeg === 0) return 0.5;
    return (rankSum - (totalPos * (totalPos + 1) / 2)) / (totalPos * totalNeg);
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Path Forecaster — Training on 10-yr 1m data (resampled to 5m)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Backup current model for comparison
    let oldModel = null;
    if (fs.existsSync(OUT_PATH)) {
        const cur = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
        fs.writeFileSync(OLD_BACKUP, JSON.stringify(cur, null, 2));
        oldModel = cur;
        console.log(`  Backed up old model (trained on ${cur.trainedOn} samples)`);
    }

    let allSamples = [];
    for (const sym of SYMBOLS) {
        const candles = loadAndResample(sym);
        if (!candles) { console.log(`  ⊘ ${sym}: data missing`); continue; }
        console.log(`  • ${sym}: ${candles.length} candles → building samples...`);
        const s = buildSamples(sym, candles);
        console.log(`    → ${s.length} labeled samples`);
        allSamples = allSamples.concat(s);
    }
    console.log(`\n  Total training samples: ${allSamples.length.toLocaleString()}`);

    if (allSamples.length < 1000) {
        console.error('  ❌ Not enough samples');
        process.exit(1);
    }

    // Shuffle + 80/20 train/validation split
    for (let i = allSamples.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allSamples[i], allSamples[j]] = [allSamples[j], allSamples[i]];
    }
    const splitIdx = Math.floor(allSamples.length * 0.8);
    const train = allSamples.slice(0, splitIdx);
    const valid = allSamples.slice(splitIdx);
    console.log(`  Train: ${train.length.toLocaleString()} · Validation: ${valid.length.toLocaleString()}\n`);

    const sides = { CALL: [], PUT: [] };
    for (const s of train) sides[s.side].push(s);
    const vSides = { CALL: [], PUT: [] };
    for (const s of valid) vSides[s.side].push(s);

    const model = {
        trainedAt: new Date().toISOString(),
        trainedOn: train.length,
        featureKeys: FEATURE_KEYS,
        lookaheadCandles: LOOKAHEAD,
        slAtrMult: SL_ATR_MULT,
        t1AtrMult: T1_ATR_MULT,
        sides: {},
        validation: {}
    };

    for (const side of ['CALL', 'PUT']) {
        console.log(`━━━ ${side} ━━━ ${sides[side].length} samples`);
        const ss = sides[side];
        const vss = vSides[side];

        console.log('  Training pT1, pSL, pTimeout (logistic)...');
        const pT1 = trainLogistic(ss, s => s.outcome === 'T1' ? 1 : 0);
        const pSL = trainLogistic(ss, s => s.outcome === 'SL' ? 1 : 0);
        const pTimeout = trainLogistic(ss, s => s.outcome === 'TIMEOUT' ? 1 : 0);

        console.log('  Training MFE, MAE (linear)...');
        const mfe = trainLinear(ss, s => Math.min(s.mfeAtr, 5));
        const mae = trainLinear(ss, s => Math.min(s.maeAtr, 5));

        // Validation
        const baseT1 = ss.filter(s => s.outcome === 'T1').length / ss.length;
        const baseSL = ss.filter(s => s.outcome === 'SL').length / ss.length;
        const validT1 = vss.filter(s => s.outcome === 'T1').length / vss.length;
        const aucT1 = auc(vss, pT1, s => s.outcome === 'T1');
        const aucSL = auc(vss, pSL, s => s.outcome === 'SL');

        // Compare to old model
        let oldAucT1 = null, oldAucSL = null;
        if (oldModel?.sides?.[side]) {
            oldAucT1 = auc(vss, oldModel.sides[side].pT1, s => s.outcome === 'T1');
            oldAucSL = auc(vss, oldModel.sides[side].pSL, s => s.outcome === 'SL');
        }

        model.sides[side] = { pT1, pSL, pTimeout, mfe, mae,
            stats: { winRate: baseT1, lossRate: baseSL, n: ss.length } };
        model.validation[side] = {
            base: { T1: baseT1, SL: baseSL, valid_T1: validT1 },
            new: { aucT1, aucSL },
            old: { aucT1: oldAucT1, aucSL: oldAucSL },
            improvement: oldAucT1 !== null ? {
                t1AucDelta: aucT1 - oldAucT1,
                slAucDelta: aucSL - oldAucSL
            } : null
        };

        console.log(`\n  ${side} validation:`);
        console.log(`    Base T1 rate: ${(baseT1 * 100).toFixed(1)}%`);
        console.log(`    NEW model AUC: T1=${aucT1.toFixed(3)}  SL=${aucSL.toFixed(3)}`);
        if (oldAucT1 !== null) {
            const t1Delta = ((aucT1 - oldAucT1) * 100).toFixed(2);
            const slDelta = ((aucSL - oldAucSL) * 100).toFixed(2);
            console.log(`    OLD model AUC: T1=${oldAucT1.toFixed(3)}  SL=${oldAucSL.toFixed(3)}`);
            console.log(`    Δ improvement: T1 ${t1Delta > 0 ? '+' : ''}${t1Delta}%  SL ${slDelta > 0 ? '+' : ''}${slDelta}%`);
        }
        console.log('');
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(model, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✓ Model saved → ${OUT_PATH}`);
    console.log(`  ✓ Old model backed up → ${OLD_BACKUP}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => { console.error(e); process.exit(1); });
