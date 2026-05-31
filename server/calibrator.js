// server/calibrator.js — Confidence calibration tracker (V2 spec)
//
// Compares predicted confidence vs realized win rate per decile bucket.
// If 90% conf trades win only 52% of time → next 90% conf score shrinks
// to ~70% so the AI learns realism.
//
// Persisted to data/calibration.json. Updated on every closed trade.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'calibration.json');

const DEFAULT = {
    buckets: {  // bucket label → { trades, wins, sumPredicted }
        '0-59':   { trades: 0, wins: 0, sumPredicted: 0 },
        '60-74':  { trades: 0, wins: 0, sumPredicted: 0 },
        '75-84':  { trades: 0, wins: 0, sumPredicted: 0 },
        '85-94':  { trades: 0, wins: 0, sumPredicted: 0 },
        '95-100': { trades: 0, wins: 0, sumPredicted: 0 }
    },
    perGrade: {},          // grade → { trades, wins, pnl }
    perRegime: {},         // regime → { trades, wins, pnl }
    perStrategy: {},       // strategy id → { trades, wins, pnl }
    lastUpdated: null
};

function bucketOf(score) {
    if (score >= 95) return '95-100';
    if (score >= 85) return '85-94';
    if (score >= 75) return '75-84';
    if (score >= 60) return '60-74';
    return '0-59';
}

class Calibrator {
    constructor() {
        this.data = this.load();
    }
    load() {
        try {
            if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        } catch (e) { console.error('[calibrator] load failed', e); }
        return structuredClone(DEFAULT);
    }
    save() {
        try {
            fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2));
        } catch (e) { console.error('[calibrator] save failed', e); }
    }

    // Record a closed trade
    record({ approvalScore, grade, regime, strategyIds = [], pnl, result }) {
        const isWin = result === 'WIN' || pnl > 0;
        const b = bucketOf(approvalScore || 0);
        const bk = this.data.buckets[b];
        bk.trades++; bk.sumPredicted += approvalScore || 0;
        if (isWin) bk.wins++;

        const g = this.data.perGrade[grade] ??= { trades: 0, wins: 0, pnl: 0 };
        g.trades++; if (isWin) g.wins++; g.pnl += pnl || 0;

        const r = this.data.perRegime[regime || 'unknown'] ??= { trades: 0, wins: 0, pnl: 0 };
        r.trades++; if (isWin) r.wins++; r.pnl += pnl || 0;

        for (const sid of strategyIds) {
            const s = this.data.perStrategy[sid] ??= { trades: 0, wins: 0, pnl: 0 };
            s.trades++; if (isWin) s.wins++; s.pnl += pnl || 0;
        }

        this.data.lastUpdated = new Date().toISOString();
        this.save();
    }

    // Adjust raw approval score using realized calibration.
    // If 90% conf trades win only 50% → adjusted = 90 * (50/90) = 50.
    // Damped to ±20% per V2 spec (Rule: max adjustment ±20%).
    adjust(rawScore) {
        const b = bucketOf(rawScore);
        const bk = this.data.buckets[b];
        if (!bk || bk.trades < 10) return { adjusted: rawScore, delta: 0, samples: bk?.trades || 0, note: 'insufficient samples' };
        const realizedWinRate = bk.wins / bk.trades * 100;
        const avgPredicted = bk.sumPredicted / bk.trades;
        if (avgPredicted === 0) return { adjusted: rawScore, delta: 0, samples: bk.trades, note: 'no predictions' };
        const ratio = realizedWinRate / avgPredicted;   // <1 means over-confident
        // Cap adjustment factor at ±20%
        const clampedRatio = Math.max(0.8, Math.min(1.2, ratio));
        const adjusted = Math.round(rawScore * clampedRatio);
        return {
            adjusted,
            delta: adjusted - rawScore,
            samples: bk.trades,
            realizedWinRate: parseFloat(realizedWinRate.toFixed(1)),
            avgPredicted: parseFloat(avgPredicted.toFixed(1))
        };
    }

    summary() {
        const out = { buckets: {}, perGrade: this.data.perGrade, perRegime: this.data.perRegime,
                      perStrategy: this.data.perStrategy, lastUpdated: this.data.lastUpdated };
        for (const [b, bk] of Object.entries(this.data.buckets)) {
            out.buckets[b] = {
                trades: bk.trades,
                wins: bk.wins,
                realizedWinRate: bk.trades ? parseFloat((bk.wins / bk.trades * 100).toFixed(1)) : null,
                avgPredicted: bk.trades ? parseFloat((bk.sumPredicted / bk.trades).toFixed(1)) : null
            };
        }
        return out;
    }
}

export const calibrator = new Calibrator();
