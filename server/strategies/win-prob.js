// server/strategies/win-prob.js — Bootstrap win-probability scorer.
//
// Logistic regression trained on backtest trade outcomes. Pure Node — no
// Python / no XGBoost dependency. Saves model to data/win-prob-model.json.
//
// Training: takes an array of {featureVector, result} → fits sigmoid weights
// via gradient descent. Online update: after each live trade, mini-batch GD
// on the new sample (high learning rate for first 50 live trades, then anneal).
//
// Why logistic regression (not XGBoost from day 1)?
//   • Trains in 5-10 seconds on 1000 samples (XGBoost: tuning is a project)
//   • Easy to interpret (each feature has a single weight)
//   • Robust to small sample sizes
//   • Online learning is trivial — just one extra GD step per new trade
//   • When we have 500+ real trades, we can swap to XGBoost in Python.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, '..', '..', 'data', 'win-prob-model.json');

// ============================================================
//  Feature ordering — must be stable across train + predict
// ============================================================
export const FEATURES = [
    'confidence_raw',
    'callScore',
    'putScore',
    'newsScore',
    'rsiV5',
    'atrPct',
    'adxV',
    'volRatio',
    'pcr',
    'atmIV',
    'ivPct',
    // Categorical one-hots
    'side_call',
    'side_put',
    'regime_trending_up',
    'regime_trending_down',
    'regime_ranging',
    'regime_volatile',
    'regime_quiet',
    'session_morning',
    'session_afternoon',
    'tier_high',
    'tier_medium',
    'tier_low'
];

function vectorize(fv) {
    const v = [
        fv.confidence_raw ?? 0,
        fv.callScore ?? 0,
        fv.putScore ?? 0,
        fv.newsScore ?? 0,
        fv.rsiV5 ?? 50,
        fv.atrPct ?? 0,
        fv.adxV ?? 20,
        fv.volRatio ?? 1,
        fv.pcr ?? 1,
        fv.atmIV ?? 15,
        fv.ivPct ?? 50,
        fv.side === 'BUY_CALL' ? 1 : 0,
        fv.side === 'BUY_PUT' ? 1 : 0,
        fv.regime === 'trending_up' ? 1 : 0,
        fv.regime === 'trending_down' ? 1 : 0,
        fv.regime === 'ranging' ? 1 : 0,
        fv.regime === 'volatile' ? 1 : 0,
        fv.regime === 'quiet' ? 1 : 0,
        fv.sessionPhase === 'morning' ? 1 : 0,
        fv.sessionPhase === 'afternoon' ? 1 : 0,
        fv.tier === 'HIGH' ? 1 : 0,
        fv.tier === 'MEDIUM' ? 1 : 0,
        fv.tier === 'LOW' ? 1 : 0
    ];
    return v;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Z-score normalization stats (mean/std per feature)
function standardize(X) {
    const n = X.length, d = X[0].length;
    const mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
    for (let j = 0; j < d; j++) mean[j] /= n;
    for (const row of X) for (let j = 0; j < d; j++) std[j] += Math.pow(row[j] - mean[j], 2);
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;
    return { mean, std };
}

function applyStandardize(row, mean, std) {
    return row.map((v, j) => (v - mean[j]) / std[j]);
}

// ============================================================
//  Trainer
// ============================================================
export function trainModel(samples, opts = {}) {
    const { epochs = 300, lr = 0.08, l2 = 0.001, valSplit = 0.2, verbose = false } = opts;
    if (samples.length < 30) throw new Error('Need at least 30 samples to train');

    // Shuffle deterministically
    const idx = samples.map((_, i) => i).sort((a, b) => ((a * 2654435761) % 1) - ((b * 2654435761) % 1));
    const shuffled = idx.map(i => samples[i]);

    const X_raw = shuffled.map(s => vectorize(s.featureVector || s));
    const y = shuffled.map(s => (s.result === 'WIN' || s.label === 1) ? 1 : 0);

    // Standardize
    const { mean, std } = standardize(X_raw);
    const X = X_raw.map(row => applyStandardize(row, mean, std));

    // Train/val split
    const cut = Math.floor(X.length * (1 - valSplit));
    const X_tr = X.slice(0, cut), y_tr = y.slice(0, cut);
    const X_val = X.slice(cut), y_val = y.slice(cut);

    // Init weights to small random + bias
    const d = X[0].length;
    const w = new Array(d).fill(0).map(() => (Math.random() - 0.5) * 0.01);
    let b = 0;

    for (let ep = 0; ep < epochs; ep++) {
        let gW = new Array(d).fill(0), gB = 0;
        for (let i = 0; i < X_tr.length; i++) {
            let z = b;
            for (let j = 0; j < d; j++) z += w[j] * X_tr[i][j];
            const p = sigmoid(z);
            const err = p - y_tr[i];
            for (let j = 0; j < d; j++) gW[j] += err * X_tr[i][j];
            gB += err;
        }
        for (let j = 0; j < d; j++) {
            w[j] -= lr * (gW[j] / X_tr.length + l2 * w[j]);
        }
        b -= lr * (gB / X_tr.length);

        if (verbose && ep % 50 === 0) {
            const loss = computeLoss(X_tr, y_tr, w, b);
            const acc = computeAcc(X_val, y_val, w, b);
            console.log(`  epoch ${ep}: loss=${loss.toFixed(4)}  val_acc=${(acc * 100).toFixed(1)}%`);
        }
    }

    // Final metrics
    const trainAcc = computeAcc(X_tr, y_tr, w, b);
    const valAcc = computeAcc(X_val, y_val, w, b);
    const valLoss = computeLoss(X_val, y_val, w, b);
    const valLogloss = computeLogLoss(X_val, y_val, w, b);

    return {
        weights: w, bias: b, mean, std,
        features: FEATURES,
        trainedAt: Date.now(),
        sampleCount: samples.length,
        trainAcc, valAcc, valLoss, valLogloss,
        // Show top-3 most important features
        topFeatures: getTopFeatures(w, FEATURES, 5)
    };
}

function computeLoss(X, y, w, b) {
    let sum = 0;
    for (let i = 0; i < X.length; i++) {
        let z = b;
        for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
        const p = sigmoid(z);
        sum += Math.pow(p - y[i], 2);
    }
    return sum / X.length;
}

function computeAcc(X, y, w, b) {
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
        let z = b;
        for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
        const p = sigmoid(z);
        if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    }
    return X.length ? correct / X.length : 0;
}

function computeLogLoss(X, y, w, b) {
    let sum = 0;
    for (let i = 0; i < X.length; i++) {
        let z = b;
        for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
        let p = sigmoid(z);
        p = Math.max(1e-7, Math.min(1 - 1e-7, p));
        sum -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p);
    }
    return X.length ? sum / X.length : 0;
}

function getTopFeatures(w, names, k = 5) {
    return w.map((v, i) => ({ name: names[i], weight: parseFloat(v.toFixed(3)) }))
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
        .slice(0, k);
}

// ============================================================
//  Inference + Online learning
// ============================================================
class WinProbModel {
    constructor() { this._loadOrBootstrap(); }

    _loadOrBootstrap() {
        try {
            if (fs.existsSync(MODEL_PATH)) {
                this.model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8'));
                return;
            }
        } catch (_) {}
        this.model = null;
    }

    save() {
        if (!this.model) return;
        fs.writeFileSync(MODEL_PATH, JSON.stringify(this.model, null, 2));
    }

    setModel(m) {
        this.model = m;
        this.save();
    }

    isReady() { return !!this.model && Array.isArray(this.model.weights); }

    predict(featureVector) {
        if (!this.isReady()) {
            return { winProbability: 0.5, confidence: 'no model', features: null };
        }
        const x = vectorize(featureVector);
        const xs = applyStandardize(x, this.model.mean, this.model.std);
        let z = this.model.bias;
        for (let j = 0; j < this.model.weights.length; j++) z += this.model.weights[j] * xs[j];
        const p = sigmoid(z);

        // Per-feature contribution: w_j * standardized_x_j
        const contributions = this.model.weights.map((w, j) => ({
            name: this.model.features[j],
            value: parseFloat((w * xs[j]).toFixed(3))
        })).filter(c => Math.abs(c.value) > 0.01).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

        return {
            winProbability: parseFloat(p.toFixed(4)),
            winProbabilityPct: Math.round(p * 100),
            edge: parseFloat((p - 0.5).toFixed(4)),
            confidence: p > 0.65 ? 'HIGH' : p > 0.52 ? 'MEDIUM' : p > 0.45 ? 'LOW' : 'NEGATIVE',
            topContributions: contributions.slice(0, 6),
            modelInfo: {
                sampleCount: this.model.sampleCount,
                valAcc: parseFloat((this.model.valAcc * 100).toFixed(1)),
                trainedAt: this.model.trainedAt
            }
        };
    }

    // Online single-sample SGD update — called after each closed trade
    onlineUpdate(featureVector, result, lr = 0.02) {
        if (!this.isReady()) return;
        const x = vectorize(featureVector);
        const xs = applyStandardize(x, this.model.mean, this.model.std);
        let z = this.model.bias;
        for (let j = 0; j < this.model.weights.length; j++) z += this.model.weights[j] * xs[j];
        const p = sigmoid(z);
        const y = result === 'WIN' ? 1 : 0;
        const err = p - y;
        for (let j = 0; j < this.model.weights.length; j++) {
            this.model.weights[j] -= lr * (err * xs[j] + 0.0005 * this.model.weights[j]);
        }
        this.model.bias -= lr * err;
        this.model.sampleCount = (this.model.sampleCount || 0) + 1;
        this.model.lastOnlineUpdate = Date.now();
        this.save();
    }
}

export const winProbModel = new WinProbModel();
