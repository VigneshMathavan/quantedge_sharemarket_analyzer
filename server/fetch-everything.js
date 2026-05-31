// server/fetch-everything.js — comprehensive Upstox historical fetch
// across every supported timeframe × every symbol × maximum available history.
//
// Upstox v3 quirks (confirmed by testing):
//   • days/1 max 1-year window, supports ~10+ years back
//   • minutes/30 max 90-day window, supports ~5 years back
//   • minutes/15, minutes/5 — max 30-day windows, ~5 years back
//   • minutes/1 — max 30-day windows, since 2022-02 only
//   • hours/1 → 404 (not supported for indices). RESAMPLE from 30min instead.
//   • minutes/3 → 404 (not supported). RESAMPLE from 1min instead.
//
// Resampled timeframes are computed AFTER native fetches complete.

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

// Native Upstox endpoints — what they support
const NATIVE_JOBS = [
    { tf: '1day',     unit: 'days',    interval: 1,  windowDays: 365, since: '2016-01-01' },
    { tf: '30minute', unit: 'minutes', interval: 30, windowDays: 90,  since: '2020-01-01' },
    { tf: '15minute', unit: 'minutes', interval: 15, windowDays: 30,  since: '2022-02-01' },
    { tf: '5minute',  unit: 'minutes', interval: 5,  windowDays: 30,  since: '2022-02-01' },
    { tf: '1minute',  unit: 'minutes', interval: 1,  windowDays: 30,  since: '2022-02-01' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = d => d.toISOString().slice(0, 10);
const TOKEN = process.env.UPSTOX_EXTENDED_TOKEN || process.env.UPSTOX_ACCESS_TOKEN;
if (!TOKEN) { console.error('No token available'); process.exit(1); }
const provider = new UpstoxProvider({ extendedToken: process.env.UPSTOX_EXTENDED_TOKEN, accessToken: process.env.UPSTOX_ACCESS_TOKEN, apiKey: process.env.UPSTOX_API_KEY });

async function fetchWindow(symbol, job, from, to) {
    const enc = encodeURIComponent(SYMBOL_KEYS[symbol]);
    const p = `/v3/historical-candle/${enc}/${job.unit}/${job.interval}/${fmt(to)}/${fmt(from)}`;
    try {
        const j = await provider._get(p, {});
        return (j.data?.candles || []).map(c => ({
            time: Math.floor(new Date(c[0]).getTime() / 1000),
            open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]),
            volume: parseInt(c[5] || 0, 10)
        }));
    } catch (e) { return []; }
}

async function fetchSymbolTf(symbol, job) {
    const outPath = path.join(OUT_DIR, `${symbol}_${job.tf}.json`);
    // Skip if already have substantial data
    if (fs.existsSync(outPath)) {
        const existing = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        if (existing.length > 1000) {
            console.log(`  ✓ ${symbol} ${job.tf}: ${existing.length.toLocaleString()} (cached)`);
            return existing.length;
        }
    }
    const startDate = new Date(job.since);
    const endDate = new Date();
    const all = new Map();
    let cur = new Date(startDate);
    let win = 0, ok = 0;
    const total = Math.ceil(((endDate - startDate) / 86400000) / job.windowDays);
    while (cur < endDate) {
        win++;
        const winEnd = new Date(Math.min(cur.getTime() + job.windowDays * 86400000, endDate.getTime()));
        const candles = await fetchWindow(symbol, job, cur, winEnd);
        if (candles.length) ok++;
        for (const c of candles) all.set(c.time, c);
        process.stdout.write(`  ${symbol} ${job.tf}: ${win}/${total} ${candles.length?'✓':'✗'} total=${all.size.toLocaleString()}    \r`);
        await sleep(180);
        cur = new Date(winEnd.getTime() + 86400000);
    }
    const arr = Array.from(all.values()).sort((a, b) => a.time - b.time);
    fs.writeFileSync(outPath, JSON.stringify(arr));
    const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`\n  ✓ ${symbol} ${job.tf}: ${arr.length.toLocaleString()} candles · ${ok}/${total} windows · ${sizeMb}MB`);
    return arr.length;
}

// Resample candles into coarser buckets
function resample(candles, targetSec) {
    if (!candles?.length) return [];
    const out = [];
    let bucket = null;
    for (const c of candles) {
        const start = Math.floor(c.time / targetSec) * targetSec;
        if (!bucket || bucket.time !== start) {
            if (bucket) out.push(bucket);
            bucket = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
        } else {
            bucket.high = Math.max(bucket.high, c.high);
            bucket.low = Math.min(bucket.low, c.low);
            bucket.close = c.close;
            bucket.volume += (c.volume || 0);
        }
    }
    if (bucket) out.push(bucket);
    return out;
}

// Synthesize 3min from 1min, 60min from 30min
async function synthesizeResampled() {
    console.log('\n━━━ Synthesizing 3min + 60min (Upstox doesn\'t supply these) ━━━');
    for (const sym of Object.keys(SYMBOL_KEYS)) {
        // 3min from 1min
        const oneMinPath = path.join(OUT_DIR, `${sym}_1minute.json`);
        if (fs.existsSync(oneMinPath)) {
            const oneMin = JSON.parse(fs.readFileSync(oneMinPath, 'utf-8'));
            const threeMin = resample(oneMin, 180);
            fs.writeFileSync(path.join(OUT_DIR, `${sym}_3minute.json`), JSON.stringify(threeMin));
            console.log(`  ✓ ${sym} 3minute: ${threeMin.length.toLocaleString()} (resampled from 1min)`);
        }
        // 60min from 30min
        const thirtyMinPath = path.join(OUT_DIR, `${sym}_30minute.json`);
        if (fs.existsSync(thirtyMinPath)) {
            const thirtyMin = JSON.parse(fs.readFileSync(thirtyMinPath, 'utf-8'));
            const sixtyMin = resample(thirtyMin, 3600);
            fs.writeFileSync(path.join(OUT_DIR, `${sym}_60minute.json`), JSON.stringify(sixtyMin));
            console.log(`  ✓ ${sym} 60minute: ${sixtyMin.length.toLocaleString()} (resampled from 30min)`);
        }
    }
}

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  COMPREHENSIVE FETCH — every TF × every symbol × max history');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const start = Date.now();
    const stats = {};
    for (const sym of Object.keys(SYMBOL_KEYS)) {
        console.log(`\n━━━ ${sym} ━━━`);
        stats[sym] = {};
        for (const job of NATIVE_JOBS) {
            stats[sym][job.tf] = await fetchSymbolTf(sym, job);
        }
    }
    await synthesizeResampled();
    const took = (Date.now() - start) / 1000;
    fs.writeFileSync(path.join(OUT_DIR, '_summary.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), tookSec: took, stats }, null, 2));
    console.log(`\n✓ Complete in ${(took/60).toFixed(1)} min`);
}

main().catch(e => { console.error(e); process.exit(1); });
