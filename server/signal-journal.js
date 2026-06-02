// server/signal-journal.js
//
// FOUNDATION for the Historical Intelligence Engine described in the
// master spec. Logs every signal that fires (with full parameter vector,
// chain context, and forecast) to an append-only JSONL file.
//
// Once we have enough rows + a real database (Supabase), this becomes
// the lookup source for "current setup resembles 124 historical
// occurrences, 74% win rate" similarity scoring.
//
// For now: write-only. The similarity matcher is a separate module.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(JOURNAL_DIR)) fs.mkdirSync(JOURNAL_DIR, { recursive: true });
const JOURNAL_PATH = path.join(JOURNAL_DIR, 'signal-journal.jsonl');

let _writeQueue = [];
let _writing = false;

async function flushQueue() {
    if (_writing || _writeQueue.length === 0) return;
    _writing = true;
    const batch = _writeQueue.splice(0, _writeQueue.length);
    const lines = batch.map(r => JSON.stringify(r)).join('\n') + '\n';
    try {
        await fs.promises.appendFile(JOURNAL_PATH, lines);
    } catch (e) {
        console.error('[signal-journal] write failed:', e.message);
    }
    _writing = false;
    if (_writeQueue.length) flushQueue();
}

// Log a single signal-firing event. Non-blocking — writes async.
export function logSignalFire({ symbol, side, candles, votes, confluenceScore, regime, forecast, approval, chainSnapshot, tier, actionable }) {
    if (!symbol || side === 'NO_TRADE') return;
    const lastCandle = candles?.[candles?.length - 1];
    const record = {
        ts: Date.now(),
        symbol,
        side,
        tier: tier || actionable?.potentialTier || null,
        confluenceScore: confluenceScore || 0,
        regime: regime?.regime || null,
        approvalScore: approval?.finalScore || null,
        approvalGrade: approval?.grade || null,
        forecast: forecast ? {
            verdict: forecast.verdict,
            pT1: forecast.pT1, pSL: forecast.pSL,
            confidence: forecast.confidence
        } : null,
        firingStrategies: (votes || [])
            .filter(v => v.fired)
            .map(v => ({ id: v.id, name: v.name, score: v.weight, reason: v.reason })),
        priceContext: lastCandle ? {
            close: lastCandle.close,
            high: lastCandle.high,
            low: lastCandle.low,
            volume: lastCandle.volume
        } : null,
        chainContext: chainSnapshot ? {
            atm: chainSnapshot.atm,
            pcr: chainSnapshot.pcr,
            maxPain: chainSnapshot.maxPain,
            expiry: chainSnapshot.expiry,
            totalCallOI: chainSnapshot.totalCallOI,
            totalPutOI: chainSnapshot.totalPutOI
        } : null,
        actionable: actionable ? {
            strike: actionable.option?.strike,
            right: actionable.option?.right,
            premium: actionable.option?.premium,
            premiumSL: actionable.option?.premiumSL,
            premiumT1: actionable.option?.premiumT1,
            premiumT2: actionable.option?.premiumT2,
            delta: actionable.option?.delta,
            iv: actionable.option?.iv,
            oi: actionable.option?.oi,
            riskReward: actionable.riskReward
        } : null
    };
    _writeQueue.push(record);
    setImmediate(flushQueue);
}

// Read recent journal entries — used by similarity matcher (future).
export async function readRecentSignals(limit = 1000) {
    try {
        if (!fs.existsSync(JOURNAL_PATH)) return [];
        const data = await fs.promises.readFile(JOURNAL_PATH, 'utf-8');
        const lines = data.trim().split('\n').slice(-limit);
        return lines.map(l => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
    } catch (e) { return []; }
}
