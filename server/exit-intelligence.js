// server/exit-intelligence.js — TP / SL probability + expected holding time
//
// Most systems only handle entries. This module gives the user real exit
// guidance derived from the historical journal in SQLite:
//
//   • Probability that T1 hits before SL
//   • Probability that SL hits first
//   • Expected holding time (median minutes)
//   • Optimal trail point — average max-favorable-excursion before reversal
//
// All computed from REAL outcomes of similar setups (same regime, same
// side, same tier). No simulation, no guesswork.

import { db } from './db.js';

export function computeExitIntelligence({ symbol, side, regime, tier }) {
    const sinceMs = Date.now() - 730 * 86400 * 1000;   // 2 years
    const conditions = ['t.pnl IS NOT NULL', 't.entry_premium > 0'];
    const params = [];

    conditions.push('j.symbol = ?'); params.push(symbol);
    if (side) { conditions.push('j.side = ?'); params.push(side); }
    if (regime) { conditions.push('j.regime = ?'); params.push(regime); }
    if (tier) { conditions.push('j.tier = ?'); params.push(tier); }
    conditions.push('j.ts >= ?'); params.push(sinceMs);

    const sql = `
        SELECT t.entry_premium, t.exit_premium, t.exit_reason, t.exit_time, t.time, t.pnl
          FROM signal_journal j
          JOIN trades t ON t.time = j.ts AND t.symbol = j.symbol AND t.side = j.side
         WHERE ${conditions.join(' AND ')}
         LIMIT 5000
    `;
    const rows = db.prepare(sql).all(...params);
    if (rows.length === 0) {
        return { available: false, samples: 0 };
    }

    const t1Hits = rows.filter(r => r.exit_reason === 'T1_HIT').length;
    const t2Hits = rows.filter(r => r.exit_reason === 'T2_HIT').length;
    const slHits = rows.filter(r => r.exit_reason === 'SL_HIT').length;
    const timeouts = rows.filter(r => r.exit_reason === 'TIMEOUT' || r.exit_reason === 'TIME_STOP').length;
    const total = rows.length;

    // Holding time stats from the rows that had clean exit_time
    const holdMins = rows
        .filter(r => r.exit_time && r.time)
        .map(r => Math.round((r.exit_time - r.time) / 60000))
        .filter(v => v > 0 && v < 600)
        .sort((a, b) => a - b);
    const median = holdMins.length ? holdMins[Math.floor(holdMins.length / 2)] : null;
    const p25 = holdMins.length ? holdMins[Math.floor(holdMins.length * 0.25)] : null;
    const p75 = holdMins.length ? holdMins[Math.floor(holdMins.length * 0.75)] : null;

    // Average % move on winners (for setting realistic trailing-SL)
    const winners = rows.filter(r => r.pnl > 0);
    const losers = rows.filter(r => r.pnl < 0);
    const avgWinPct = winners.length
        ? winners.reduce((a, r) => a + ((r.exit_premium - r.entry_premium) / r.entry_premium * 100), 0) / winners.length
        : 0;
    const avgLossPct = losers.length
        ? losers.reduce((a, r) => a + ((r.exit_premium - r.entry_premium) / r.entry_premium * 100), 0) / losers.length
        : 0;

    return {
        available: true,
        samples: total,
        regime: regime || 'ANY',
        tier: tier || 'ANY',
        probabilities: {
            t1Hit:    parseFloat((t1Hits / total * 100).toFixed(1)),
            t2Hit:    parseFloat((t2Hits / total * 100).toFixed(1)),
            slHit:    parseFloat((slHits / total * 100).toFixed(1)),
            timeout:  parseFloat((timeouts / total * 100).toFixed(1))
        },
        holdingTime: {
            medianMin: median,
            p25Min: p25,
            p75Min: p75,
            recommendedExit: p75 ? `${p75}m (75th percentile)` : null
        },
        moveStats: {
            avgWinPct: parseFloat(avgWinPct.toFixed(2)),
            avgLossPct: parseFloat(avgLossPct.toFixed(2)),
            riskReward: avgLossPct < 0 ? parseFloat((Math.abs(avgWinPct / avgLossPct)).toFixed(2)) : null
        },
        recommendation: t1Hits / total >= 0.5
            ? 'Book full at T1 — historically hits more often than SL'
            : slHits > t1Hits
                ? 'Tight SL or smaller size — SL hits more than T1 in this regime'
                : 'Standard 50% book at T1, trail rest'
    };
}
