// server/fetch-10yr.js — Download 10-year history from Upstox for all 4 indices.
//
// Upstox v3 historical-candle limits per call:
//   • days/1     max 1 year window  → 10 calls per symbol
//   • hours/1    max 1 year          → 10 calls per symbol
//   • minutes/30 max 1 quarter       → 40 calls per symbol
//   • minutes/15 max 1 quarter       → 40 calls per symbol
//   • minutes/5  max 1 quarter       → 40 calls (data from 2022-01-31 only)
//   • minutes/1  max 1 month         → max ~50 calls (data from 2022-01-31 only)
//
// Output: data/historical/<SYMBOL>_<TF>.json  (full OHLC array)
// Throttled to ~5 req/s to stay well under Upstox rate limit.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { UpstoxProvider } from './upstox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'historical');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SYMBOL_KEYS = {
    NIFTY:     'NSE_INDEX|Nifty 50',
    SENSEX:    'BSE_INDEX|SENSEX',
    BANKNIFTY: 'NSE_INDEX|Nifty Bank',
    FINNIFTY:  'NSE_INDEX|Nifty Fin Service'
};

// Define fetch jobs: each job = (timeframe, windowDays, totalYears, since)
// Notes on Upstox v3 endpoint quirks discovered during testing:
//   • "hours/1" returns 404 → use "minutes/60" instead
//   • 5min/15min need smaller windows (~30 days) — 90-day windows 404
//   • "3minute" not supported by historical endpoint at all → skip
const JOBS = [
    { tf: '1day',     unit: 'days',    interval: 1, windowDays: 365,  years: 10, since: '2016-01-01' },
    { tf: '60minute', unit: 'minutes', interval: 60, windowDays: 365, years: 10, since: '2016-01-01' },
    { tf: '30minute', unit: 'minutes', interval: 30, windowDays: 90,  years: 10, since: '2016-01-01' },
    { tf: '15minute', unit: 'minutes', interval: 15, windowDays: 30,  years: 5,  since: '2022-01-31' },
    { tf: '5minute',  unit: 'minutes', interval: 5,  windowDays: 30,  years: 5,  since: '2022-01-31' },
    { tf: '1minute',  unit: 'minutes', interval: 1,  windowDays: 30,  years: 5,  since: '2022-01-31' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toISOString().slice(0, 10);

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
if (!TOKEN) { console.error('UPSTOX_ACCESS_TOKEN missing'); process.exit(1); }

const provider = new UpstoxProvider({ accessToken: TOKEN, apiKey: process.env.UPSTOX_API_KEY });

async function fetchWindow(symbol, job, fromDate, toDate) {
    const key = SYMBOL_KEYS[symbol];
    const enc = encodeURIComponent(key);
    const path = `/v3/historical-candle/${enc}/${job.unit}/${job.interval}/${fmt(toDate)}/${fmt(fromDate)}`;
    try {
        const j = await provider._get(path, {});
        const candles = j.data?.candles || [];
        return candles.map(c => ({
            time: Math.floor(new Date(c[0]).getTime() / 1000),
            open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]),
            volume: parseInt(c[5] || 0, 10)
        }));
    } catch (e) {
        console.error(`  ✗ ${symbol} ${job.tf} ${fmt(fromDate)}→${fmt(toDate)}: ${e.message.slice(0, 80)}`);
        return [];
    }
}

async function fetchSymbolTf(symbol, job) {
    const outPath = path.join(OUT_DIR, `${symbol}_${job.tf}.json`);
    const startDate = new Date(job.since);
    const endDate = new Date();
    const allCandles = new Map();  // dedupe by timestamp

    let cur = new Date(startDate);
    const totalWindows = Math.ceil(((endDate - startDate) / 86400000) / job.windowDays);
    let win = 0;
    while (cur < endDate) {
        win++;
        const winEnd = new Date(Math.min(cur.getTime() + job.windowDays * 86400000, endDate.getTime()));
        const candles = await fetchWindow(symbol, job, cur, winEnd);
        for (const c of candles) allCandles.set(c.time, c);
        process.stdout.write(`  ${symbol} ${job.tf}: window ${win}/${totalWindows} (${fmt(cur)}→${fmt(winEnd)}) +${candles.length} candles, total=${allCandles.size}    \r`);
        await sleep(220);  // ~5 req/s
        cur = new Date(winEnd.getTime() + 86400000);
    }

    const arr = Array.from(allCandles.values()).sort((a, b) => a.time - b.time);
    fs.writeFileSync(outPath, JSON.stringify(arr));
    console.log(`\n  ✓ ${symbol} ${job.tf}: ${arr.length} candles saved (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)}MB)`);
    return arr.length;
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  10-year Upstox historical fetch · ${Object.keys(SYMBOL_KEYS).length} symbols × ${JOBS.length} timeframes`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const start = Date.now();
    const stats = {};
    for (const symbol of Object.keys(SYMBOL_KEYS)) {
        console.log(`\n━━━ ${symbol} ━━━`);
        stats[symbol] = {};
        for (const job of JOBS) {
            const n = await fetchSymbolTf(symbol, job);
            stats[symbol][job.tf] = n;
        }
    }
    const took = (Date.now() - start) / 1000;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ✓ Complete in ${took.toFixed(1)}s`);
    console.log(`  Summary:`);
    for (const [sym, byTf] of Object.entries(stats)) {
        console.log(`    ${sym}:`);
        for (const [tf, n] of Object.entries(byTf)) console.log(`      ${tf.padEnd(10)} ${n.toLocaleString()} candles`);
    }
    fs.writeFileSync(path.join(OUT_DIR, '_summary.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), tookSec: took, stats }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
