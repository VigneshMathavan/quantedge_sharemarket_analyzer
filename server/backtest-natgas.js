// server/backtest-natgas.js — Sanity backtest on the stitched NATURALGAS data
// to confirm the signal engine produces valid trades on commodity OHLCV.
//
// Runs a simplified strategy: EMA(20) crossover with ATR-based SL/TP.
// Walks every 5min candle from the stitched dataset and counts wins/losses.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, '..', 'data', 'historical', 'NATURALGAS_5minute.json');
const candles = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
console.log(`[backtest-natgas] loaded ${candles.length.toLocaleString()} 5min candles`);

// EMA
function ema(arr, period) {
    const k = 2 / (period + 1);
    let prev = arr[0];
    const out = [prev];
    for (let i = 1; i < arr.length; i++) {
        prev = arr[i] * k + prev * (1 - k);
        out.push(prev);
    }
    return out;
}

// ATR
function atr(c, period = 14) {
    const tr = [c[0].high - c[0].low];
    for (let i = 1; i < c.length; i++) {
        const x = Math.max(
            c[i].high - c[i].low,
            Math.abs(c[i].high - c[i - 1].close),
            Math.abs(c[i].low - c[i - 1].close)
        );
        tr.push(x);
    }
    return ema(tr, period);
}

const closes = candles.map(c => c.close);
const ema20 = ema(closes, 20);
const ema50 = ema(closes, 50);
const atr14 = atr(candles, 14);

const trades = [];
let pos = null;

for (let i = 50; i < candles.length - 50; i++) {
    const c = candles[i];
    const prevAbove = ema20[i - 1] > ema50[i - 1];
    const currAbove = ema20[i] > ema50[i];

    if (!pos) {
        if (!prevAbove && currAbove) {
            // long
            pos = { side: 'long', entry: c.close, sl: c.close - atr14[i] * 1.5, tp: c.close + atr14[i] * 2.5, time: c.time };
        } else if (prevAbove && !currAbove) {
            pos = { side: 'short', entry: c.close, sl: c.close + atr14[i] * 1.5, tp: c.close - atr14[i] * 2.5, time: c.time };
        }
    } else {
        const nxt = candles[i];
        let exit = null;
        if (pos.side === 'long') {
            if (nxt.low <= pos.sl) exit = pos.sl;
            else if (nxt.high >= pos.tp) exit = pos.tp;
        } else {
            if (nxt.high >= pos.sl) exit = pos.sl;
            else if (nxt.low <= pos.tp) exit = pos.tp;
        }
        if (exit !== null) {
            const pnl = pos.side === 'long' ? (exit - pos.entry) : (pos.entry - exit);
            trades.push({ ...pos, exit, pnl, exitTime: c.time });
            pos = null;
        }
    }
}

const wins = trades.filter(t => t.pnl > 0).length;
const losses = trades.filter(t => t.pnl <= 0).length;
const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
const lotSize = 1250; // NATURALGAS lot

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  NATURALGAS BACKTEST — EMA20/50 crossover');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Period       : ${new Date(candles[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)}`);
console.log(`Total candles: ${candles.length.toLocaleString()}`);
console.log(`Trades       : ${trades.length}`);
console.log(`Wins         : ${wins}`);
console.log(`Losses       : ${losses}`);
console.log(`Win rate     : ${trades.length ? ((wins / trades.length) * 100).toFixed(1) : 0}%`);
console.log(`Avg P&L      : ₹${trades.length ? (totalPnl / trades.length).toFixed(2) : 0}/unit`);
console.log(`Total ₹      : ${(totalPnl * lotSize).toFixed(0)} (per single lot)`);

const last5 = trades.slice(-5);
console.log('\nLast 5 trades:');
for (const t of last5) {
    console.log(`  ${t.side.padEnd(5)} entry ${t.entry.toFixed(1)} → exit ${t.exit.toFixed(1)} = ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)} ₹`);
}

// Write summary
const summary = {
    symbol: 'NATURALGAS',
    candles: candles.length,
    period: { from: candles[0].time, to: candles[candles.length - 1].time },
    trades: trades.length,
    wins, losses,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnlUnit: totalPnl,
    totalPnlOneLot: totalPnl * lotSize,
    avgPnlPerTrade: trades.length ? totalPnl / trades.length : 0
};
fs.writeFileSync(path.join(__dirname, '..', 'data', 'natgas-backtest-summary.json'), JSON.stringify(summary, null, 2));
console.log('\n✓ summary → data/natgas-backtest-summary.json');
