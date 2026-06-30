// server/ml/counterfactual-model.js — predict "we should have fired"
// Logistic regression on COUNTERFACTUAL_FAILURE (label 1) vs CORRECT_REJECT (0)
// over the feature vector at signal time.

import { db, kvGet, kvSet, sysLog } from '../db.js';

const KEY = 'cf_model_v1';
const FEATURES = ['rsi14','vwap_dist_pct','volume_ratio','atr14_pct','pcr','atm_iv','omega_score'];

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function loadDataset({ days = 90, limit = 5000 } = {}) {
    const since = Date.now() - days * 86400_000;
    return db.prepare(`
        SELECT decision as cf_label, symbol, timestamp as ts, actual_pnl as move_pct
          FROM counterfactual_log_v2
         WHERE decision IN ('COUNTERFACTUAL_FAILURE','CORRECT_REJECT') AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT ?
    `).all(since, limit);
}

function featuresAt(symbol, ts) {
    const out = {};
    for (const f of FEATURES) {
        const row = db.prepare(`
            SELECT value_num FROM feature_values
             WHERE name = ? AND symbol = ? AND as_of_ts <= ?
             ORDER BY as_of_ts DESC LIMIT 1
        `).get(f, symbol, ts);
        out[f] = row?.value_num ?? 0;
    }
    return out;
}

export function trainCounterfactual({ days = 90, lr = 0.05, epochs = 300 } = {}) {
    const rows = loadDataset({ days });
    if (rows.length < 100) return { status: 'INSUFFICIENT', n: rows.length };
    const X = [], y = [];
    for (const r of rows) {
        const f = featuresAt(r.symbol, r.ts);
        X.push(FEATURES.map(k => f[k] || 0));
        y.push(r.cf_label === 'COUNTERFACTUAL_FAILURE' ? 1 : 0);
    }
    // Standardize
    const mean = FEATURES.map((_, j) => X.reduce((a, x) => a + x[j], 0) / X.length);
    const sd   = FEATURES.map((_, j) => Math.sqrt(X.reduce((a, x) => a + (x[j] - mean[j]) ** 2, 0) / X.length) || 1);
    const Z = X.map(x => x.map((v, j) => (v - mean[j]) / sd[j]));
    const w = new Array(FEATURES.length).fill(0);
    let b = 0;
    for (let e = 0; e < epochs; e++) {
        let gW = new Array(FEATURES.length).fill(0), gB = 0;
        for (let i = 0; i < Z.length; i++) {
            const z = w.reduce((a, wj, j) => a + wj * Z[i][j], 0) + b;
            const p = sigmoid(z);
            const d = p - y[i];
            for (let j = 0; j < w.length; j++) gW[j] += d * Z[i][j];
            gB += d;
        }
        for (let j = 0; j < w.length; j++) w[j] -= lr * gW[j] / Z.length;
        b -= lr * gB / Z.length;
    }
    const meta = { status: 'TRAINED', n: rows.length, w, b, mean, sd, features: FEATURES, ts: Date.now() };
    kvSet(KEY, meta);
    sysLog('INFO', 'cf-model', `trained n=${rows.length} weights=${w.map(v=>v.toFixed(2)).join(',')}`);
    return meta;
}

export function predictShouldHaveFired(features) {
    const m = kvGet(KEY);
    if (!m || m.status !== 'TRAINED') return null;
    const z = FEATURES.map((k, j) => (((features[k] ?? 0) - m.mean[j]) / m.sd[j]) * m.w[j])
                      .reduce((a, b) => a + b, m.b);
    return sigmoid(z);
}

export function cfModelStatus() { return kvGet(KEY) || { status: 'NOT_TRAINED' }; }

// Auto-train daily
setInterval(() => { try { trainCounterfactual({}); } catch (_) {} }, 24 * 3600 * 1000);
setTimeout(() => { try { trainCounterfactual({}); } catch (_) {} }, 15000);
