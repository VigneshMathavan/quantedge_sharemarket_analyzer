// server/equity-curve.js
//
// Builds an equity curve from completed trades in SQLite.
// Returns:
//   • points: [{ts, equity, trade}] running cumulative P&L per trade
//   • summary: peak, trough, currentDD, maxDD, totalReturn
//
// Used by:
//   • Today's-trades modal sparkline
//   • Backtest panel detailed view
//   • Ops dashboard equity tile

import { db } from './db.js';

export function buildEquityCurve({ sinceMs = null, symbol = null } = {}) {
    const conditions = ['pnl IS NOT NULL'];
    const params = [];
    if (sinceMs) {
        conditions.push('time >= ?');
        params.push(sinceMs);
    }
    if (symbol) {
        conditions.push('symbol = ?');
        params.push(symbol);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT id, time, exit_time, symbol, side, strike, pnl, result
                 FROM trades ${where} ORDER BY COALESCE(exit_time, time) ASC`;
    const rows = db.prepare(sql).all(...params);

    if (rows.length === 0) {
        return {
            points: [],
            summary: {
                totalTrades: 0, wins: 0, losses: 0, winRate: 0,
                totalReturn: 0, peak: 0, trough: 0, maxDrawdown: 0,
                currentEquity: 0
            }
        };
    }

    let equity = 0, peak = 0, maxDd = 0;
    const points = [];
    for (const r of rows) {
        equity += (r.pnl || 0);
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDd) maxDd = dd;
        points.push({
            ts: r.exit_time || r.time,
            equity: Math.round(equity),
            trade: {
                id: r.id, symbol: r.symbol, side: r.side, strike: r.strike,
                pnl: r.pnl, result: r.result
            }
        });
    }

    const wins = rows.filter(r => r.pnl > 0).length;
    const losses = rows.filter(r => r.pnl < 0).length;
    const trough = Math.min(...points.map(p => p.equity));
    const currentEquity = points[points.length - 1].equity;
    const currentDd = peak - currentEquity;

    return {
        points,
        summary: {
            totalTrades: rows.length,
            wins, losses,
            winRate: parseFloat((wins / rows.length * 100).toFixed(1)),
            totalReturn: currentEquity,
            peak, trough,
            currentEquity,
            currentDrawdown: currentDd,
            maxDrawdown: maxDd
        }
    };
}
