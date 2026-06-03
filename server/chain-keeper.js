// server/chain-keeper.js — PERSISTENT OPTION CHAIN CACHE
//
// Problem we're solving:
//   • /api/option-chain hits Upstox on every request → slow + throttle-prone
//   • Upstox sometimes returns empty {} → UI sees "chain unavailable"
//   • After market close, chain is dead → engine returns NO_TRADE forever
//
// Solution: server-side background poller per symbol that:
//   1. Pulls chain every 2s during market hours, 30s after
//   2. Caches the LAST KNOWN GOOD chain in memory
//   3. On Upstox error / empty response → keeps serving the cached version
//      with a `stalenessSec` flag so UI knows it's not fresh
//   4. Retries with exponential backoff on consecutive failures
//   5. Persists last-good snapshot to SQLite so it survives restarts
//
// Public API:
//   • getChain(symbol)         → { chain, lastFetchMs, stalenessSec, status }
//   • startChainKeeper(provider) → spins up the per-symbol pollers
//   • getChainStatus()         → diagnostic snapshot for ops dashboard

import { kvGet, kvSet, sysLog } from './db.js';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];

// In-memory state per symbol
const state = {};
SYMBOLS.forEach(sym => {
    state[sym] = {
        chain: null,
        lastFetchMs: 0,
        lastSuccessMs: 0,
        lastError: null,
        consecutiveFailures: 0,
        status: 'INIT',
        pollIntervalId: null
    };
});

// Restore last-known-good from SQLite on boot (survives restarts)
function restoreFromSqlite() {
    for (const sym of SYMBOLS) {
        const cached = kvGet(`chain_cache_${sym}`);
        if (cached && cached.chain && cached.lastSuccessMs) {
            state[sym].chain = cached.chain;
            state[sym].lastSuccessMs = cached.lastSuccessMs;
            state[sym].lastFetchMs = cached.lastSuccessMs;
            state[sym].status = 'RESTORED_FROM_DISK';
            const ageMin = Math.round((Date.now() - cached.lastSuccessMs) / 60000);
            sysLog('INFO', 'chain-keeper', `${sym}: restored cached chain from disk (${ageMin}min old, ${cached.chain.length} rows)`);
        }
    }
}

function isMarketHours() {
    const istMs = Date.now() + (5 * 60 + 30) * 60000;
    const ist = new Date(istMs);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

async function pollOnce(provider, symbol) {
    const s = state[symbol];
    s.lastFetchMs = Date.now();
    try {
        const chain = await provider.getOptionChain(symbol);
        if (!Array.isArray(chain) || chain.length === 0) {
            // Broker returned empty — count as soft failure but keep cache
            s.consecutiveFailures++;
            s.status = s.chain ? 'STALE_BROKER_EMPTY' : 'NO_DATA';
            s.lastError = 'broker returned empty';
            return;
        }
        // SUCCESS — update cache
        s.chain = chain;
        s.lastSuccessMs = Date.now();
        s.consecutiveFailures = 0;
        s.status = 'LIVE';
        s.lastError = null;
        // Persist last-good to SQLite every minute (avoid hammering disk)
        if (!s._lastDiskSaveMs || Date.now() - s._lastDiskSaveMs > 60_000) {
            try {
                kvSet(`chain_cache_${symbol}`, {
                    chain,
                    lastSuccessMs: s.lastSuccessMs,
                    rowCount: chain.length
                });
                s._lastDiskSaveMs = Date.now();
            } catch (e) { /* non-fatal */ }
        }
    } catch (e) {
        s.consecutiveFailures++;
        s.status = s.chain ? 'STALE_BROKER_ERROR' : 'ERROR';
        s.lastError = e.message.slice(0, 120);
        if (s.consecutiveFailures === 1 || s.consecutiveFailures % 10 === 0) {
            sysLog('WARN', 'chain-keeper', `${symbol}: fetch failed (${s.consecutiveFailures}x) — ${s.lastError}`);
        }
    }
}

function scheduleSymbol(provider, symbol) {
    const s = state[symbol];
    if (s.pollIntervalId) clearInterval(s.pollIntervalId);
    // Adaptive cadence: 2s during market, 60s after, plus backoff on failures
    const baseInterval = () => isMarketHours() ? 2000 : 60000;
    const cadence = () => {
        const base = baseInterval();
        // Exponential backoff if we're failing repeatedly (cap at 30s)
        if (s.consecutiveFailures >= 5) return Math.min(30000, base * Math.pow(1.5, s.consecutiveFailures - 5));
        return base;
    };
    const tick = async () => {
        await pollOnce(provider, symbol);
        // Re-schedule next tick with current cadence
        clearInterval(s.pollIntervalId);
        s.pollIntervalId = setTimeout(tick, cadence());
    };
    s.pollIntervalId = setTimeout(tick, 100);  // first poll near-immediately
}

export function startChainKeeper(provider) {
    restoreFromSqlite();
    for (const sym of SYMBOLS) scheduleSymbol(provider, sym);
    sysLog('INFO', 'chain-keeper', `started for ${SYMBOLS.length} symbols`);
    console.log(`[chain-keeper] started — ${SYMBOLS.length} symbols, persistent cache`);
}

export function getChain(symbol) {
    const s = state[symbol];
    if (!s) return { chain: [], status: 'UNKNOWN_SYMBOL', stalenessSec: null, lastFetchMs: 0 };
    const stalenessSec = s.lastSuccessMs ? Math.floor((Date.now() - s.lastSuccessMs) / 1000) : null;
    return {
        chain: s.chain || [],
        lastFetchMs: s.lastFetchMs,
        lastSuccessMs: s.lastSuccessMs,
        stalenessSec,
        status: s.status,
        rowCount: s.chain?.length || 0,
        consecutiveFailures: s.consecutiveFailures,
        lastError: s.lastError
    };
}

export function getChainStatus() {
    return SYMBOLS.map(sym => {
        const c = getChain(sym);
        return {
            symbol: sym,
            status: c.status,
            rows: c.rowCount,
            stalenessSec: c.stalenessSec,
            failures: c.consecutiveFailures,
            lastError: c.lastError
        };
    });
}
