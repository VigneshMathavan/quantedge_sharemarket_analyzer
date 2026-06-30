// server/ml/calibration-platt.js — Platt scaling for Omega scores
//
// Persona: the calibration verdict is POORLY_CALIBRATED (ECE 0.42). This module
// fits a 1-parameter logistic A·x + B over (Omega, outcome) pairs from
// shadow_signals and exposes calibrated(x) so the gate can use a fair p(WIN).
//
// Algorithm (Platt 1999, simplified):
//   minimise NLL over Bernoulli(σ(A·x + B)) using gradient descent
//   1000 epochs, lr 0.01, no regularisation — corpus is large.

import { db, kvGet, kvSet, sysLog } from '../db.js';

const KEY = 'calibration_platt_v1';

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function fit({ days = 30, minSamples = 200 } = {}) {
    const since = Date.now() - days * 86400_000;
    const rows = db.prepare(`
        SELECT confidence x, CASE WHEN outcome='WIN' THEN 1 ELSE 0 END y, regime
          FROM shadow_signals
         WHERE outcome IN ('WIN','LOSS') AND confidence IS NOT NULL AND ts >= ?
    `).all(since);
    if (rows.length < minSamples) {
        return { status: 'INSUFFICIENT', n: rows.length, global: { A: 1, B: 0 }, regimes: {} };
    }

    const optimize = (dataRows) => {
        const xs = dataRows.map(r => (r.x / 100) * 2 - 1);
        const ys = dataRows.map(r => r.y);
        let A = 1, B = 0;
        const lr = 0.05;
        const epochs = 800;
        for (let e = 0; e < epochs; e++) {
            let gA = 0, gB = 0;
            for (let i = 0; i < xs.length; i++) {
                const p = sigmoid(A * xs[i] + B);
                const d = p - ys[i];
                gA += d * xs[i];
                gB += d;
            }
            A -= lr * gA / xs.length;
            B -= lr * gB / xs.length;
        }
        return { A, B };
    };

    const globalParams = optimize(rows);

    const regimes = {};
    const byRegime = {};
    for (const r of rows) {
        if (!r.regime) continue;
        if (!byRegime[r.regime]) byRegime[r.regime] = [];
        byRegime[r.regime].push(r);
    }
    
    for (const [regime, rRows] of Object.entries(byRegime)) {
        if (rRows.length >= minSamples) {
            regimes[regime] = optimize(rRows);
        }
    }

    const meta = { status: 'FITTED', n: rows.length, global: globalParams, regimes, fittedAt: Date.now(), days };
    kvSet(KEY, meta);
    sysLog('INFO', 'platt', `fitted global n=${rows.length} A=${globalParams.A.toFixed(3)} B=${globalParams.B.toFixed(3)}, regimes=${Object.keys(regimes).join(',')}`);
    return meta;
}

export function calibrate(rawOmega, regime) {
    const meta = kvGet(KEY);
    if (!meta || meta.status !== 'FITTED') return rawOmega / 100;
    const x = (rawOmega / 100) * 2 - 1;
    
    let A = meta.global ? meta.global.A : (meta.A ?? 1);
    let B = meta.global ? meta.global.B : (meta.B ?? 0);
    
    if (regime && meta.regimes && meta.regimes[regime]) {
        A = meta.regimes[regime].A;
        B = meta.regimes[regime].B;
    }
    
    return sigmoid(A * x + B);
}

export function calibratedBand(rawOmega, regime) {
    const p = calibrate(rawOmega, regime) * 100;
    if (p >= 95) return { score: p, band: 'ELITE' };
    if (p >= 90) return { score: p, band: 'STRONG' };
    if (p >= 80) return { score: p, band: 'WATCHLIST' };
    if (p >= 60) return { score: p, band: 'IGNORE' };
    return { score: p, band: 'REJECT' };
}

export function getPlattStatus() {
    return kvGet(KEY) || { status: 'NOT_FITTED' };
}

export function refit(opts) { return fit(opts); }

// Auto-refit nightly
setInterval(() => {
    try { fit({ days: 30 }); } catch (e) { sysLog('WARN', 'platt', e.message); }
}, 6 * 3600 * 1000);

// Initial fit on import
setTimeout(() => { try { fit({ days: 30 }); } catch (_) {} }, 5000);
