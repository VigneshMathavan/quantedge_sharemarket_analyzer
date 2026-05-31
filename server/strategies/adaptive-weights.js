// server/strategies/adaptive-weights.js — Multi-armed-bandit style strategy weighting.
//
// Closes the "learn from past trades" loop without resorting to RL.
//
// Idea (Thompson sampling / Exponentially weighted average):
//   • Each strategy starts with its default weight
//   • After every trade closes, increment that strategy's wins/losses
//   • Weight is scaled by a factor that grows when the strategy wins more and
//     shrinks when it loses. Bounded so a single hot streak can't dominate.
//
// Persists to data/strategy-weights.json so it survives backend restarts.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'strategy-weights.json');

class AdaptiveWeights {
    constructor() {
        // strategyId → { wins, losses, weightMultiplier }
        this.stats = {};
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(STORE_PATH)) {
                this.stats = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
            }
        } catch (_) {}
    }

    _save() {
        try {
            fs.writeFileSync(STORE_PATH, JSON.stringify(this.stats, null, 2));
        } catch (_) {}
    }

    // Record an outcome for the strategies that contributed to the trade
    recordOutcome(strategyIds, result /* 'WIN' or 'LOSS' */) {
        for (const id of strategyIds) {
            if (!this.stats[id]) this.stats[id] = { wins: 0, losses: 0 };
            if (result === 'WIN') this.stats[id].wins++;
            else this.stats[id].losses++;
        }
        this._save();
    }

    // Get the adaptive multiplier for a strategy id
    // Returns 1.0 when no data; bounded between 0.5 and 1.5
    getMultiplier(id) {
        const s = this.stats[id];
        if (!s) return 1.0;
        const total = s.wins + s.losses;
        if (total < 5) return 1.0;  // need minimum sample
        const winRate = s.wins / total;
        // Map winRate [0.3, 0.7] → multiplier [0.5, 1.5]
        const m = 0.5 + ((winRate - 0.3) / 0.4);
        return Math.max(0.5, Math.min(1.5, m));
    }

    // Dump all current weights for the UI / debug
    snapshot() {
        const out = {};
        for (const id of Object.keys(this.stats)) {
            const s = this.stats[id];
            const total = s.wins + s.losses;
            out[id] = {
                wins: s.wins,
                losses: s.losses,
                total,
                winRate: total ? parseFloat(((s.wins / total) * 100).toFixed(1)) : null,
                multiplier: parseFloat(this.getMultiplier(id).toFixed(3))
            };
        }
        return out;
    }
}

export const adaptiveWeights = new AdaptiveWeights();
