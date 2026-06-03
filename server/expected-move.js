// server/expected-move.js — Priority 9: Expected Move Engine
//
// Computes Conservative / Average / Aggressive expected move % from
// the historical journal — same regime, same side, same time-of-day
// bucket. Returns also expected duration. All from REAL trades in
// SQLite, no estimates.

import { db } from './db.js';

const LOOKBACK_DAYS = 730;       // 2 years of seeded history per regime

export function computeExpectedMove({ symbol, side, regime, candleClose }) {
    const sinceMs = Date.now() - LOOKBACK_DAYS * 86400 * 1000;
    const sideClause = side ? `AND j.side = ?` : '';
    const regimeClause = regime ? `AND j.regime = ?` : '';

    const params = [symbol];
    if (side) params.push(side);
    if (regime) params.push(regime);
    params.push(sinceMs);

    const rows = db.prepare(`
        SELECT t.entry_premium, t.exit_premium, t.exit_time, t.time, t.pnl
          FROM signal_journal j
          JOIN trades t ON t.time = j.ts AND t.symbol = j.symbol AND t.side = j.side
         WHERE j.symbol = ?
           ${sideClause}
           ${regimeClause}
           AND j.ts >= ?
           AND t.entry_premium > 0
           AND t.exit_premium > 0
           AND t.pnl IS NOT NULL
         LIMIT 5000
    `).all(...params);

    if (rows.length === 0) {
        return { available: false, samples: 0 };
    }

    // Pct move per trade
    const movePcts = rows
        .map(r => ((r.exit_premium - r.entry_premium) / r.entry_premium) * 100)
        .filter(v => isFinite(v) && Math.abs(v) < 1000);

    const durations = rows
        .filter(r => r.exit_time && r.time)
        .map(r => Math.max(1, Math.round((r.exit_time - r.time) / 60000)))
        .filter(v => v > 0 && v < 600);   // skip bogus multi-day rows

    movePcts.sort((a, b) => a - b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

    return {
        available: true,
        samples: rows.length,
        regime: regime || 'ANY',
        movePct: {
            conservative: parseFloat(pct(movePcts, 0.25).toFixed(2)),  // 25th percentile
            average:      parseFloat(pct(movePcts, 0.50).toFixed(2)),  // median
            aggressive:   parseFloat(pct(movePcts, 0.75).toFixed(2))   // 75th percentile
        },
        winRate: parseFloat((rows.filter(r => r.pnl > 0).length / rows.length * 100).toFixed(1)),
        avgDurationMin: durations.length
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : null,
        // Expected absolute move in price terms if entry premium given
        expectedAbsoluteMove: candleClose
            ? parseFloat((candleClose * pct(movePcts, 0.50) / 100).toFixed(2))
            : null
    };
}
