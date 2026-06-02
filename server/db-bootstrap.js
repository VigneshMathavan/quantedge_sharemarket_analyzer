// server/db-bootstrap.js — one-shot migration from legacy JSON files
// into the new SQLite database. Idempotent: re-running is safe.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveTrade, logSignal, kvSet, sysLog, getDbStats } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function safeReadJson(file) {
    try {
        const p = path.join(DATA_DIR, file);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
        console.error(`[bootstrap] failed to read ${file}:`, e.message);
        return null;
    }
}

export function runBootstrap() {
    const statsBefore = getDbStats();
    if (statsBefore.tradeCount > 0) {
        console.log(`[bootstrap] DB already has ${statsBefore.tradeCount} trades, ${statsBefore.signalCount} signals — skipping migration`);
        sysLog('INFO', 'bootstrap', `skipped (already migrated)`);
        return;
    }

    // ─── Migrate week-trades.json ───
    const weekTrades = safeReadJson('week-trades.json');
    let tradesMigrated = 0;
    if (weekTrades?.trades?.length) {
        for (const t of weekTrades.trades) {
            if (saveTrade(t)) tradesMigrated++;
        }
        console.log(`[bootstrap] migrated ${tradesMigrated}/${weekTrades.trades.length} trades from week-trades.json`);
    }

    // ─── Migrate signal-journal.jsonl ───
    const journalPath = path.join(DATA_DIR, 'signal-journal.jsonl');
    let signalsMigrated = 0;
    if (fs.existsSync(journalPath)) {
        try {
            const raw = fs.readFileSync(journalPath, 'utf-8');
            const lines = raw.trim().split('\n').slice(-5000);
            for (const line of lines) {
                try { const r = JSON.parse(line); if (logSignal(r)) signalsMigrated++; } catch {}
            }
            console.log(`[bootstrap] migrated ${signalsMigrated} signals from signal-journal.jsonl`);
        } catch (e) {
            console.error('[bootstrap] journal migration failed:', e.message);
        }
    }

    // ─── Migrate win-prob-model.json into KV ───
    const wpm = safeReadJson('win-prob-model.json');
    if (wpm) {
        kvSet('win_prob_model', wpm);
        console.log(`[bootstrap] win-prob model copied to KV (${wpm.sampleCount || 0} samples)`);
    }

    sysLog('INFO', 'bootstrap', `migrated ${tradesMigrated} trades, ${signalsMigrated} signals`);
    const after = getDbStats();
    console.log(`[bootstrap] complete — DB now has ${after.tradeCount} trades, ${after.signalCount} signals`);
}
