// server/auto-retrain.js — Weekly retrain scheduler for Path Forecaster.
//
// Runs every Sunday at 03:00 IST. Spawns the training script as a child
// process so a failure doesn't crash the live backend. On success the
// path-forecaster re-loads the new model file. Old model is backed up
// so we can roll back if the new one is worse.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { pathForecaster } from './path-forecaster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAIN_SCRIPT = path.join(__dirname, 'path-forecaster', 'train.js');
const MODEL_PATH = path.join(__dirname, '..', 'data', 'path-forecaster-model.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'model-archive');

function nowIst() {
    return new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
}

function backupCurrentModel() {
    if (!fs.existsSync(MODEL_PATH)) return null;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = nowIst().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `path-forecaster-${stamp}.json`);
    fs.copyFileSync(MODEL_PATH, dest);
    return dest;
}

export function runRetrain() {
    return new Promise((resolve) => {
        const start = Date.now();
        const backupPath = backupCurrentModel();
        console.log(`[auto-retrain] starting · backup=${backupPath || 'none'}`);

        const child = spawn(process.execPath, [TRAIN_SCRIPT], {
            cwd: path.join(__dirname, '..'),
            env: process.env
        });
        const logs = [];
        child.stdout.on('data', d => { const s = d.toString(); logs.push(s); process.stdout.write('[retrain] ' + s); });
        child.stderr.on('data', d => { const s = d.toString(); logs.push(s); process.stderr.write('[retrain] ' + s); });

        child.on('close', (code) => {
            const tookMs = Date.now() - start;
            if (code === 0) {
                pathForecaster.load();
                console.log(`[auto-retrain] ✓ done in ${(tookMs / 1000).toFixed(1)}s — model reloaded`);
                resolve({ ok: true, tookMs, backupPath, code });
            } else {
                // Rollback — restore previous model so live inference still works
                if (backupPath && fs.existsSync(backupPath)) {
                    fs.copyFileSync(backupPath, MODEL_PATH);
                    pathForecaster.load();
                    console.error(`[auto-retrain] ✗ training failed (exit ${code}) — rolled back to ${backupPath}`);
                } else {
                    console.error(`[auto-retrain] ✗ training failed (exit ${code}) — no backup to restore`);
                }
                resolve({ ok: false, tookMs, code, error: 'training script failed' });
            }
        });
    });
}

// Schedule weekly. Cron logic in pure JS — no external dep.
// Sunday is day 0 in JS. We target 03:00 IST → 21:30 UTC Saturday.
export function startWeeklyScheduler() {
    let lastFired = 0;
    setInterval(() => {
        const ist = nowIst();
        const dow = ist.getUTCDay();        // 0 = Sun
        const hour = ist.getUTCHours();
        const min = ist.getUTCMinutes();
        const stamp = ist.toISOString().slice(0, 10);
        const isFireWindow = dow === 0 && hour === 3 && min < 5;
        if (isFireWindow && lastFired !== stamp) {
            lastFired = stamp;
            console.log('[auto-retrain] scheduled fire — Sunday 03:00 IST');
            runRetrain().catch(e => console.error('[auto-retrain]', e));
        }
    }, 60_000);
    console.log('[auto-retrain] weekly scheduler active — fires Sunday 03:00 IST');
}
