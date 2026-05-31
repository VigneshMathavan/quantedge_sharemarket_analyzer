// server/fetch-gaps.js — Fill the timeframes that failed in the first 10yr fetch.
// Targets: 60min, 15min, 5min for all 4 indices using corrected endpoint format.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { UpstoxProvider } from './upstox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'historical');

const SYMBOL_KEYS = {
    NIFTY:     'NSE_INDEX|Nifty 50',
    SENSEX:    'BSE_INDEX|SENSEX',
    BANKNIFTY: 'NSE_INDEX|Nifty Bank',
    FINNIFTY:  'NSE_INDEX|Nifty Fin Service'
};

const JOBS = [
    { tf: '60minute', unit: 'minutes', interval: 60, windowDays: 365, since: '2016-01-01' },
    { tf: '15minute', unit: 'minutes', interval: 15, windowDays: 30,  since: '2022-02-01' },
    { tf: '5minute',  unit: 'minutes', interval: 5,  windowDays: 30,  since: '2022-02-01' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toISOString().slice(0, 10);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const provider = new UpstoxProvider({ accessToken: TOKEN, apiKey: process.env.UPSTOX_API_KEY });

async function fetchWindow(symbol, job, fromDate, toDate) {
    const enc = encodeURIComponent(SYMBOL_KEYS[symbol]);
    const path = `/v3/historical-candle/${enc}/${job.unit}/${job.interval}/${fmt(toDate)}/${fmt(fromDate)}`;
    try {
        const j = await provider._get(path, {});
        return (j.data?.candles || []).map(c => ({
            time: Math.floor(new Date(c[0]).getTime() / 1000),
            open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]),
            volume: parseInt(c[5] || 0, 10)
        }));
    } catch (e) {
        return [];
    }
}

async function fetchSymbolTf(symbol, job) {
    const outPath = path.join(OUT_DIR, `${symbol}_${job.tf}.json`);
    const startDate = new Date(job.since);
    const endDate = new Date();
    const all = new Map();
    let cur = new Date(startDate);
    let win = 0, ok = 0, fail = 0;
    const total = Math.ceil(((endDate - startDate) / 86400000) / job.windowDays);
    while (cur < endDate) {
        win++;
        const winEnd = new Date(Math.min(cur.getTime() + job.windowDays * 86400000, endDate.getTime()));
        const candles = await fetchWindow(symbol, job, cur, winEnd);
        if (candles.length) ok++; else fail++;
        for (const c of candles) all.set(c.time, c);
        process.stdout.write(`  ${symbol} ${job.tf}: ${win}/${total} (${candles.length>0?'✓':'✗'}) total=${all.size}    \r`);
        await sleep(220);
        cur = new Date(winEnd.getTime() + 86400000);
    }
    const arr = Array.from(all.values()).sort((a, b) => a.time - b.time);
    fs.writeFileSync(outPath, JSON.stringify(arr));
    console.log(`\n  ✓ ${symbol} ${job.tf}: ${arr.length.toLocaleString()} candles (${ok}/${total} windows ok, ${(fs.statSync(outPath).size/1024/1024).toFixed(1)}MB)`);
    return arr.length;
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Gap-fill: 60min + 15min + 5min × 4 symbols`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const symbol of Object.keys(SYMBOL_KEYS)) {
        console.log(`\n━━━ ${symbol} ━━━`);
        for (const job of JOBS) await fetchSymbolTf(symbol, job);
    }
    console.log('\n✓ Gap fill complete');
}

main().catch(e => { console.error(e); process.exit(1); });
