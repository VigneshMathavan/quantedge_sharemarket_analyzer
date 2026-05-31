// server/fetch-history.js — Pull 5 years daily + 60 days intraday for NIFTY/SENSEX/FINNIFTY/BANKNIFTY.
//
// Run:   node fetch-history.js
// Output: data/<SYMBOL>_<TIMEFRAME>.json
//
// Yahoo Finance free quotas (empirical, 2026):
//   • interval=1d  → up to 10 years per request (we'll pull 5 years)
//   • interval=60m → up to ~2 years
//   • interval=15m → up to ~60 days
//   • interval=5m  → up to ~60 days
//   • interval=1m  → up to 7 days
//
// We pull what's available; longer intraday history would require a paid feed.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SYMBOLS = {
    NIFTY:     '^NSEI',
    SENSEX:    '^BSESN',
    FINNIFTY:  'NIFTY_FIN_SERVICE.NS',
    BANKNIFTY: '^NSEBANK',
    INDIA_VIX: '^INDIAVIX'  // bonus — track volatility regime
};

const TIMEFRAMES = [
    { interval: '1d',  range: '5y',  label: '1day'    },
    { interval: '60m', range: '2y',  label: '60minute' },
    { interval: '15m', range: '60d', label: '15minute' },
    { interval: '5m',  range: '60d', label: '5minute'  },
];

async function fetchOne(yahooSym, interval, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&range=${range}&includePrePost=false`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`${yahooSym} ${interval} ${r.status}`);
    const j = await r.json();
    const result = j.chart?.result?.[0];
    if (!result) throw new Error(`${yahooSym} ${interval} empty`);
    const times = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < times.length; i++) {
        if (q.open?.[i] == null || q.close?.[i] == null) continue;
        candles.push({
            time: times[i],
            open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
            volume: q.volume?.[i] || 0
        });
    }
    return candles;
}

async function main() {
    const summary = {};
    for (const [sym, yahoo] of Object.entries(SYMBOLS)) {
        summary[sym] = {};
        for (const tf of TIMEFRAMES) {
            try {
                process.stdout.write(`  ${sym} ${tf.label} (${tf.range})... `);
                const candles = await fetchOne(yahoo, tf.interval, tf.range);
                const outPath = path.join(OUT_DIR, `${sym}_${tf.label}.json`);
                fs.writeFileSync(outPath, JSON.stringify(candles));
                console.log(`${candles.length} candles → ${path.basename(outPath)}`);
                summary[sym][tf.label] = candles.length;
                // Be polite to Yahoo
                await new Promise(r => setTimeout(r, 800));
            } catch (e) {
                console.log(`FAIL: ${e.message}`);
                summary[sym][tf.label] = `error: ${e.message}`;
            }
        }
    }
    const summaryPath = path.join(OUT_DIR, '_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        fetchedAt: new Date().toISOString(),
        symbols: summary
    }, null, 2));
    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\nAll files in ${OUT_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log('Fetching historical data...\n');
    main().catch(e => { console.error(e); process.exit(1); });
}

export { fetchOne, SYMBOLS, TIMEFRAMES };
