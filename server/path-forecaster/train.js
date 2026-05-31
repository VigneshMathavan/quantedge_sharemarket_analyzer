// server/path-forecaster/train.js — Train the Path Forecaster on 5-yr 5m data.
//
// Workflow:
//   1. Load 5yr 5min candles for NIFTY, SENSEX, BANKNIFTY, FINNIFTY
//   2. For each candle i (≥50, ≤N-LOOKAHEAD):
//        - Compute features at close[i]
//        - Simulate a CALL entry and a PUT entry
//          (SL = entry - 1.5*ATR for CALL ; T1 = entry + 1.2*ATR)
//        - Scan next LOOKAHEAD candles → label outcome + MFE/MAE
//   3. Train per-side logistic models (pT1, pSL, pTimeout)
//      + linear regressions (MFE_atr, MAE_atr) via batch gradient descent
//   4. Save data/path-forecaster-model.json
//
// Run: node server/path-forecaster/train.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ema, rsi, atr } from '../signal2.js';
import { extractFeatures } from '../path-forecaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'path-forecaster-model.json');

const SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'];
const TF = '5minute';
const TF_MIN = 5;
const LOOKAHEAD = 12;           // 12 × 5min = 60 min outlook
const SL_ATR_MULT = 1.5;
const T1_ATR_MULT = 1.2;

const FEATURE_KEYS = [
    'rsiNorm', 'e20Slope', 'e50Slope', 'emaDist', 'ema2050',
    'atrRatio', 'bodyRatio', 'rangePct', 'prev3Dir', 'sessionFrac'
];

function loadCandles(symbol) {
    const p = path.join(DATA_DIR, `${symbol}_${TF}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// Label one entry → { outcome, mfeAtr, maeAtr }
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
        // Favorable excursion for our direction
        const favHigh = isCall ? c.high : -c.low;
        const advLow = isCall ? c.low : -c.high;
        const favMove = (favHigh - direction * entry) * direction;
        const advMove = -(advLow - direction * entry) * direction;
        if (favMove > mfe) mfe = favMove;
        if (advMove > mae) mae = advMove;

        // Touch tests — assume worst-case order if both touched in same candle (SL first)
        const touchSL = isCall ? c.low <= slPrice : c.high >= slPrice;
        const touchT1 = isCall ? c.high >= t1Price : c.low <= t1Price;
        if (touchSL && touchT1) { outcome = 'SL'; break; }
        if (touchSL) { outcome = 'SL'; break; }
        if (touchT1) { outcome = 'T1'; break; }
    }
    return {
        outcome,
        mfeAtr: mfe / atrAt,
        maeAtr: mae / atrAt
    };
}

function buildSamples(symbol, candles) {
    if (!candles || candles.length < 100) return [];
    const samples = [];
    const atr14 = atr(candles, 14);

    // Slide window: at each i, take last 220 candles up to i, extract features,
    // and label outcomes for both sides.
    for (let i = 60; i < candles.length - LOOKAHEAD - 1; i++) {
        const window = candles.slice(Math.max(0, i - 220), i + 1);
        const atrAt = atr14[i] || 1;
        if (atrAt <= 0) continue;
        const f = extractFeatures(window, TF_MIN);
        if (!f) continue;

        // Skip illiquid / overnight gap candles
        const range = candles[i].high - candles[i].low;
        if (range / candles[i].close < 0.0003) continue;

        for (const side of ['CALL', 'PUT']) {
            const label = labelEntry(candles, i, atrAt, side);
            samples.push({ features: f, side, ...label });
        }
    }
    return samples;
}

// --- Logistic regression via batch gradient descent ---
function trainLogistic(samples, getY) {
    const w = {};
    let b = 0;
    for (const k of FEATURE_KEYS) w[k] = 0;
    const lr = 0.05;
    const epochs = 80;
    const N = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
        const gW = {};
        for (const k of FEATURE_KEYS) gW[k] = 0;
        let gB = 0;
        let loss = 0;
        for (const s of samples) {
            let z = b;
            for (const k of FEATURE_KEYS) z += w[k] * (s.features[k] || 0);
            const p = 1 / (1 + Math.exp(-z));
            const y = getY(s);
            const err = p - y;
            for (const k of FEATURE_KEYS) gW[k] += err * (s.features[k] || 0);
            gB += err;
            loss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9));
        }
        for (const k of FEATURE_KEYS) w[k] -= (lr / N) * gW[k];
        b -= (lr / N) * gB;
        if (epoch % 20 === 0) process.stdout.write(`  epoch ${epoch} loss=${(loss / N).toFixed(4)}\r`);
    }
    return { w, b: b };
}

// --- Linear regression (closed-form ridge) ---
function trainLinear(samples, getY) {
    const w = {};
    let b = 0;
    for (const k of FEATURE_KEYS) w[k] = 0;
    const lr = 0.02;
    const epochs = 80;
    const N = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
        const gW = {};
        for (const k of FEATURE_KEYS) gW[k] = 0;
        let gB = 0;
        let mse = 0;
        for (const s of samples) {
            let z = b;
            for (const k of FEATURE_KEYS) z += w[k] * (s.features[k] || 0);
            const y = getY(s);
            const err = z - y;
            for (const k of FEATURE_KEYS) gW[k] += err * (s.features[k] || 0);
            gB += err;
            mse += err * err;
        }
        for (const k of FEATURE_KEYS) w[k] -= (lr / N) * gW[k];
        b -= (lr / N) * gB;
        if (epoch % 20 === 0) process.stdout.write(`  epoch ${epoch} mse=${(mse / N).toFixed(4)}\r`);
    }
    return { w, b: b };
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Path Forecaster — Training on 5-yr 5m data');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    let allSamples = [];
    for (const sym of SYMBOLS) {
        const candles = loadCandles(sym);
        if (!candles) { console.log(`  ⊘ ${sym}: data missing`); continue; }
        console.log(`  • ${sym}: ${candles.length} candles → building samples...`);
        const s = buildSamples(sym, candles);
        console.log(`    → ${s.length} labeled samples`);
        allSamples = allSamples.concat(s);
    }
    console.log(`\n  Total training samples: ${allSamples.length}`);
    if (allSamples.length < 1000) {
        console.error('  ❌ Not enough samples — aborting');
        process.exit(1);
    }

    // Split by side
    const sides = { CALL: [], PUT: [] };
    for (const s of allSamples) sides[s.side].push(s);
    console.log(`  CALL: ${sides.CALL.length} · PUT: ${sides.PUT.length}\n`);

    const model = {
        trainedAt: new Date().toISOString(),
        trainedOn: allSamples.length,
        featureKeys: FEATURE_KEYS,
        lookaheadCandles: LOOKAHEAD,
        slAtrMult: SL_ATR_MULT,
        t1AtrMult: T1_ATR_MULT,
        sides: {}
    };

    for (const side of ['CALL', 'PUT']) {
        console.log(`━━━ ${side} ━━━`);
        const ss = sides[side];

        console.log('  Training pT1 (logistic)...');
        const pT1 = trainLogistic(ss, s => s.outcome === 'T1' ? 1 : 0);

        console.log('\n  Training pSL (logistic)...');
        const pSL = trainLogistic(ss, s => s.outcome === 'SL' ? 1 : 0);

        console.log('\n  Training pTimeout (logistic)...');
        const pTimeout = trainLogistic(ss, s => s.outcome === 'TIMEOUT' ? 1 : 0);

        console.log('\n  Training MFE (linear)...');
        const mfe = trainLinear(ss, s => Math.min(s.mfeAtr, 5));

        console.log('\n  Training MAE (linear)...');
        const mae = trainLinear(ss, s => Math.min(s.maeAtr, 5));

        // Sanity stats
        const winRate = ss.filter(s => s.outcome === 'T1').length / ss.length;
        const lossRate = ss.filter(s => s.outcome === 'SL').length / ss.length;
        const timeoutRate = ss.filter(s => s.outcome === 'TIMEOUT').length / ss.length;

        model.sides[side] = { pT1, pSL, pTimeout, mfe, mae,
            stats: { winRate, lossRate, timeoutRate, n: ss.length } };

        console.log(`\n  → base T1=${(winRate*100).toFixed(1)}%  SL=${(lossRate*100).toFixed(1)}%  Timeout=${(timeoutRate*100).toFixed(1)}%\n`);
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(model, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✓ Model saved → ${OUT_PATH}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(e => { console.error(e); process.exit(1); });
