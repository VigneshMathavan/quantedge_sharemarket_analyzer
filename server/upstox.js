// server/upstox.js — Upstox v3 API adapter
//
// Reference: https://upstox.com/developer/api-documentation/open-api
//
// Auth model:
//   • Daily access token obtained via OAuth or "Generate" button in the
//     Upstox developer console (Market Analyzer app → Access Token → Generate).
//   • Token is a JWT-style string, ~200+ chars. Expires daily at ~3:30 AM IST.
//   • Pass as `Authorization: Bearer <access_token>` for ALL endpoints.
//
// Endpoints used:
//   • GET  /v3/market-quote/quotes      — full quote with OHLC + depth
//   • GET  /v3/market-quote/ltp         — lightweight LTP-only
//   • GET  /v3/market-quote/ohlc        — OHLC for an interval
//   • GET  /v3/historical-candle/...    — historical OHLC candles
//   • GET  /v2/option/chain             — option chain
//   • WS   wss://api.upstox.com/v3/feed/market-data-feed (future phase)
//
// Instrument keys for indices:
//   NIFTY 50  → NSE_INDEX|Nifty 50
//   SENSEX    → BSE_INDEX|SENSEX
//   BANKNIFTY → NSE_INDEX|Nifty Bank
//   FINNIFTY  → NSE_INDEX|Nifty Fin Service

import { EventEmitter } from 'events';

const BASE_URL = 'https://api.upstox.com';

// Symbol → Upstox instrument key + lot/strike-gap metadata
const SYMBOL_MAP = {
    // Current F&O lot sizes (2026) — per NSE/BSE official
    NIFTY:     { key: 'NSE_INDEX|Nifty 50',           lot_size: 65,  strike_gap: 50,  exchange: 'NSE_FO' },
    SENSEX:    { key: 'BSE_INDEX|SENSEX',             lot_size: 20,  strike_gap: 100, exchange: 'BSE_FO' },
    BANKNIFTY: { key: 'NSE_INDEX|Nifty Bank',         lot_size: 30,  strike_gap: 100, exchange: 'NSE_FO' },
    FINNIFTY:  { key: 'NSE_INDEX|Nifty Fin Service',  lot_size: 60,  strike_gap: 50,  exchange: 'NSE_FO' },
    BANKEX:    { key: 'BSE_INDEX|BANKEX',             lot_size: 30,  strike_gap: 100, exchange: 'BSE_FO' },
    // MCX commodity — Natural Gas (front-month futures, auto-rolled)
    // Each monthly contract has its own numeric token. Front-month is computed
    // dynamically from NATURALGAS_CONTRACTS based on today's date.
    // Lot size 1250 mmBtu · strike gap 5 INR
    NATURALGAS: { key: 'MCX_FO|504265', lot_size: 1250, strike_gap: 5, exchange: 'MCX_FO', isCommodity: true,
        rollover: true, contractList: 'NATURALGAS_CONTRACTS' }
};

// NATURALGAS monthly futures — sourced from Upstox MCX instrument master 2026-06-02.
// Each MCX commodity contract has its own numeric instrument key; there's no
// continuous ticker. Front-month rolls ~3 days before expiry.
export const NATURALGAS_CONTRACTS = [
    { key: 'MCX_FO|504265', symbol: 'NATURALGAS_FUT_25_JUN_26', expiry: '2026-06-25', lotSize: 1250 },
    { key: 'MCX_FO|538685', symbol: 'NATURALGAS_FUT_28_JUL_26', expiry: '2026-07-28', lotSize: 1250 },
    { key: 'MCX_FO|561496', symbol: 'NATURALGAS_FUT_26_AUG_26', expiry: '2026-08-26', lotSize: 1250 },
    { key: 'MCX_FO|568245', symbol: 'NATURALGAS_FUT_25_SEP_26', expiry: '2026-09-25', lotSize: 1250 },
    { key: 'MCX_FO|570750', symbol: 'NATURALGAS_FUT_27_OCT_26', expiry: '2026-10-27', lotSize: 1250 },
    { key: 'MCX_FO|574319', symbol: 'NATURALGAS_FUT_24_NOV_26', expiry: '2026-11-24', lotSize: 1250 }
];

// Pick the active front-month contract for a given date (rolls 3 trading days
// before expiry). Falls back to the last listed contract if all expired.
export function getNaturalGasFrontMonth(asOf = new Date()) {
    const ROLL_BUFFER_DAYS = 3;
    const ms = asOf.getTime();
    for (const c of NATURALGAS_CONTRACTS) {
        const exp = new Date(c.expiry + 'T23:59:59+05:30').getTime();
        if (ms < exp - ROLL_BUFFER_DAYS * 86400000) return c;
    }
    return NATURALGAS_CONTRACTS[NATURALGAS_CONTRACTS.length - 1];
}

// Sync SYMBOL_MAP NATURALGAS key to the active front-month at boot time so live
// quotes/historical hit the right contract.
{
    const front = getNaturalGasFrontMonth();
    SYMBOL_MAP.NATURALGAS.key = front.key;
    SYMBOL_MAP.NATURALGAS.activeSymbol = front.symbol;
    SYMBOL_MAP.NATURALGAS.expiry = front.expiry;
}

// Mask a token for logging — show only first/last 4 chars
function maskToken(tk) {
    if (!tk || tk.length < 12) return '***';
    return tk.slice(0, 6) + '…' + tk.slice(-4);
}

export class UpstoxProvider extends EventEmitter {
    constructor({ accessToken, extendedToken, apiKey, apiSecret, redirectUri }) {
        super();
        // At LEAST one token is required. Extended preferred for read-only
        // market data; daily token used for account/orders.
        if (!accessToken && !extendedToken) {
            throw new Error(
                'Upstox provider requires UPSTOX_ACCESS_TOKEN or UPSTOX_EXTENDED_TOKEN. ' +
                'Daily: account.upstox.com/developer/apps → Generate Access Token. ' +
                'Extended (annual, read-only): from Upstox Pro analytics dashboard.'
            );
        }
        this.mode = 'live';
        this.broker = 'upstox';
        this.accessToken = accessToken || '';           // daily JWT (full scope)
        this.extendedToken = extendedToken || '';        // 366-day read-only JWT
        this.apiKey = apiKey || '';
        this.apiSecret = apiSecret || '';
        this.redirectUri = redirectUri || '';
        this.subscribed = new Set();
        this.lastQuote = new Map();
        this.symbolMeta = SYMBOL_MAP;
        this._pollInterval = null;

        if (this.extendedToken) {
            console.log(`[upstox] extended token loaded (366-day, read-only) — ${maskToken(this.extendedToken)}`);
        }
        if (this.accessToken) {
            console.log(`[upstox] access token loaded (daily, full-scope) — ${maskToken(this.accessToken)}`);
        }
    }

    // Endpoints permitted by the Extended token. Anything not in this set
    // falls back to the daily token (so orders/account/profile still work).
    _isMarketDataPath(path) {
        return path.includes('/market-quote/') ||
               path.includes('/historical-candle') ||
               path.includes('/option/contract') ||
               path.includes('/option/chain') ||
               path.includes('/market/timings') ||
               path.includes('/market/holidays');
    }

    _headers(version = '3.0', path = '') {
        // Prefer Extended token for market data; fall back to access token
        const useExtended = this.extendedToken && this._isMarketDataPath(path);
        const token = useExtended ? this.extendedToken : this.accessToken;
        return {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/json',
            'Api-Version': version
        };
    }

    // Update token in-memory after OAuth refresh
    setAccessToken(token) {
        this.accessToken = token;
        console.log(`[upstox] access token rotated — ${maskToken(token)}`);
    }
    setExtendedToken(token) {
        this.extendedToken = token;
        console.log(`[upstox] extended token rotated — ${maskToken(token)}`);
    }

    async _get(path, params = {}, version = '3.0') {
        const query = Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
        const url = `${BASE_URL}${path}${query ? '?' + query : ''}`;
        const r = await fetch(url, { method: 'GET', headers: this._headers(version, path) });
        const text = await r.text();
        if (!r.ok) {
            throw new Error(`Upstox ${path} ${r.status}: ${text.slice(0, 300)}`);
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`Upstox ${path} returned non-JSON: ${text.slice(0, 200)}`);
        }
    }

    // ============================================================
    //  Sanity check — verify token works
    // ============================================================
    async verifyToken() {
        // /user/profile requires daily token (extended is read-only-data).
        // If no daily token, smoke-test extended via the quotes endpoint instead.
        if (!this.accessToken && this.extendedToken) {
            const j = await this._get('/v2/market-quote/quotes', { instrument_key: 'NSE_INDEX|Nifty 50' }, '2.0');
            if (j.status !== 'success') throw new Error('Extended token invalid');
            console.log(`[upstox] extended token verified — market data only`);
            return { mode: 'data-only' };
        }
        const j = await this._get('/v2/user/profile', {}, '2.0');
        if (j.status !== 'success') throw new Error('Token invalid: ' + JSON.stringify(j));
        const d = j.data;
        console.log(`[upstox] token verified — user: ${d.user_name || d.email} (${d.broker})`);
        return d;
    }

    // ============================================================
    //  Quotes
    // ============================================================
    async getQuote(symbol) {
        const meta = SYMBOL_MAP[symbol];
        if (!meta) throw new Error('Unknown symbol: ' + symbol);
        // v2 returns full OHLC + depth (v3 quotes endpoint was deprecated → 404)
        const j = await this._get('/v2/market-quote/quotes', { instrument_key: meta.key }, '2.0');
        const data = j.data || {};
        const row = Object.values(data)[0];
        if (!row) throw new Error('Empty quote response for ' + symbol);
        const ohlc = row.ohlc || {};
        const lastPrice = parseFloat(row.last_price || row.lastPrice || 0);
        // Use net_change from API (broker computes vs PREV day close); fallback to ohlc.close
        const netChange = parseFloat(row.net_change || 0);
        const prevClose = netChange !== 0 ? (lastPrice - netChange) : parseFloat(ohlc.close || row.close_price || 0);
        return {
            symbol,
            ltp: lastPrice,
            open: parseFloat(ohlc.open || 0),
            high: parseFloat(ohlc.high || 0),
            low: parseFloat(ohlc.low || 0),
            close: prevClose,
            volume: parseInt(row.volume || 0, 10),
            change: netChange || (prevClose ? lastPrice - prevClose : 0),
            changePercent: prevClose ? ((lastPrice - prevClose) / prevClose) * 100 : 0,
            time: row.timestamp ? new Date(row.timestamp).getTime() : Date.now(),
            instrumentKey: meta.key
        };
    }

    // Bulk fetch — single call for multiple symbols
    async getQuotes(symbols) {
        const metas = symbols.map(s => SYMBOL_MAP[s]).filter(Boolean);
        if (metas.length === 0) return [];
        const keys = metas.map(m => m.key).join(',');
        // v2 for full OHLC; v3 quotes is 404
        const j = await this._get('/v2/market-quote/quotes', { instrument_key: keys }, '2.0');
        const data = j.data || {};
        return symbols.map(sym => {
            const meta = SYMBOL_MAP[sym];
            if (!meta) return null;
            // The response keys it like "NSE_INDEX:Nifty 50" — find by partial match
            const row = Object.entries(data).find(([k]) =>
                k.replace(':', '|') === meta.key || k.endsWith(meta.key.split('|')[1])
            )?.[1];
            if (!row) return null;
            const ohlc = row.ohlc || {};
            const lp = parseFloat(row.last_price || 0);
            const pc = parseFloat(ohlc.close || 0);
            return {
                symbol: sym, ltp: lp,
                open: parseFloat(ohlc.open || 0),
                high: parseFloat(ohlc.high || 0),
                low: parseFloat(ohlc.low || 0),
                close: pc,
                volume: parseInt(row.volume || 0, 10),
                change: pc ? lp - pc : 0,
                changePercent: pc ? ((lp - pc) / pc) * 100 : 0,
                time: row.timestamp ? new Date(row.timestamp).getTime() : Date.now()
            };
        }).filter(Boolean);
    }

    // ============================================================
    //  Historical OHLC
    // ============================================================
    // GET /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to}/{from}
    // unit: minutes|hours|days|weeks|months
    // For 5-min: unit=minutes, interval=5
    // Date format: YYYY-MM-DD
    async getHistorical(symbol, timeframe = '5minute', count = 200) {
        const meta = SYMBOL_MAP[symbol];
        if (!meta) throw new Error('Unknown symbol: ' + symbol);

        // Upstox v3 doesn't expose 60min or 3min directly for indices.
        // Resample from a finer TF instead.
        if (timeframe === '60minute') {
            const base = await this.getHistorical(symbol, '30minute', count * 2 + 50);
            return resample(base, 60);
        }
        if (timeframe === '3minute') {
            const base = await this.getHistorical(symbol, '1minute', count * 3 + 50);
            return resample(base, 3);
        }

        const tfMap = {
            '1minute':  { unit: 'minutes', interval: 1 },
            '5minute':  { unit: 'minutes', interval: 5 },
            '15minute': { unit: 'minutes', interval: 15 },
            '30minute': { unit: 'minutes', interval: 30 },
            '1day':     { unit: 'days',    interval: 1 }
        };
        const tf = tfMap[timeframe] || tfMap['5minute'];
        const encKey = encodeURIComponent(meta.key);

        const parseCandle = c => ({
            time: Math.floor(new Date(c[0]).getTime() / 1000),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseInt(c[5] || 0, 10)
        });

        // Upstox splits intraday (TODAY) and historical (PAST days) into two endpoints.
        // We fetch both and merge for a seamless candle series ending NOW.
        let historicalCandles = [];
        let intradayCandles = [];

        // --- Historical (past days, excludes today) ---
        try {
            const to = new Date();
            const lookbackDays = tf.unit === 'minutes' ? 10 : tf.unit === 'hours' ? 30 : 365;
            const from = new Date(to.getTime() - lookbackDays * 86400 * 1000);
            const fmt = d => d.toISOString().slice(0, 10);
            // Historical excludes today → use yesterday as 'to'
            const toYesterday = new Date(to.getTime() - 86400 * 1000);
            const hPath = `/v3/historical-candle/${encKey}/${tf.unit}/${tf.interval}/${fmt(toYesterday)}/${fmt(from)}`;
            const hj = await this._get(hPath, {});
            historicalCandles = (hj.data?.candles || []).map(parseCandle);
        } catch (e) {
            console.error('[upstox] historical-candle failed:', e.message);
        }

        // --- Intraday (TODAY only) ---
        // Endpoint shape: /v3/historical-candle/intraday/{key}/{unit}/{interval}
        try {
            const iPath = `/v3/historical-candle/intraday/${encKey}/${tf.unit}/${tf.interval}`;
            const ij = await this._get(iPath, {});
            intradayCandles = (ij.data?.candles || []).map(parseCandle);
        } catch (e) {
            // Not all timeframes support intraday (e.g. 1day) — silent
        }

        // Merge — historical is newest-first per Upstox, reverse to oldest-first;
        // intraday same. Combine + dedupe by timestamp.
        const merged = [...historicalCandles.reverse(), ...intradayCandles.reverse()];
        const seen = new Set();
        const uniq = [];
        for (const c of merged) {
            if (!seen.has(c.time)) { seen.add(c.time); uniq.push(c); }
        }
        uniq.sort((a, b) => a.time - b.time);
        return uniq.slice(-count);
    }

    // ============================================================
    //  Option Chain (v2 — Upstox keeps option chain under v2 for now)
    // ============================================================
    async getOptionChain(symbol, expiry) {
        const meta = SYMBOL_MAP[symbol];
        if (!meta) throw new Error('Unknown symbol: ' + symbol);

        // Commodities (NATURALGAS futures) have a different chain structure on
        // MCX — strike grids per contract month. Skip the index-style chain
        // path; the frontend hides chain UI for isCommodity symbols.
        if (meta.isCommodity) return [];

        // First need to know expiry. If not given, get next expiry.
        let chosenExpiry = expiry;
        if (!chosenExpiry) {
            try {
                const ex = await this._get('/v2/option/contract', { instrument_key: meta.key }, '2.0');
                const expiries = [...new Set((ex.data || []).map(c => c.expiry))].sort();
                chosenExpiry = expiries[0];
            } catch (e) {
                console.error('[upstox] expiry lookup failed:', e.message);
                return [];
            }
        }
        if (!chosenExpiry) return [];

        try {
            const j = await this._get('/v2/option/chain', {
                instrument_key: meta.key,
                expiry_date: chosenExpiry
            }, '2.0');
            const rows = j.data || [];
            const out = [];
            for (const r of rows) {
                const strike = parseFloat(r.strike_price);
                if (r.call_options) {
                    const c = r.call_options;
                    out.push({
                        strike, type: 'CE', expiry: chosenExpiry,
                        token: c.instrument_key,
                        ltp: parseFloat(c.market_data?.ltp || 0),
                        oi: parseInt(c.market_data?.oi || 0, 10),
                        oiChange: parseInt(c.market_data?.oi_change || 0, 10),
                        iv: parseFloat(c.option_greeks?.iv || 0),
                        volume: parseInt(c.market_data?.volume || 0, 10),
                        delta: parseFloat(c.option_greeks?.delta || 0),
                        theta: parseFloat(c.option_greeks?.theta || 0),
                        vega: parseFloat(c.option_greeks?.vega || 0)
                    });
                }
                if (r.put_options) {
                    const p = r.put_options;
                    out.push({
                        strike, type: 'PE', expiry: chosenExpiry,
                        token: p.instrument_key,
                        ltp: parseFloat(p.market_data?.ltp || 0),
                        oi: parseInt(p.market_data?.oi || 0, 10),
                        oiChange: parseInt(p.market_data?.oi_change || 0, 10),
                        iv: parseFloat(p.option_greeks?.iv || 0),
                        volume: parseInt(p.market_data?.volume || 0, 10),
                        delta: parseFloat(p.option_greeks?.delta || 0),
                        theta: parseFloat(p.option_greeks?.theta || 0),
                        vega: parseFloat(p.option_greeks?.vega || 0)
                    });
                }
            }
            return out;
        } catch (e) {
            console.error('[upstox] option chain failed:', e.message);
            return [];
        }
    }

    // ============================================================
    //  Polling-based tick subscription
    //  (WebSocket integration is a separate phase — see /v3/feed/market-data-feed)
    // ============================================================
    subscribe(symbols) { symbols.forEach(s => this.subscribed.add(s)); this._ensurePolling(); }
    unsubscribe(symbols) { symbols.forEach(s => this.subscribed.delete(s)); }

    _ensurePolling() {
        if (this._pollInterval) return;
        // ULTRA-FAST tick loop: v3 LTP endpoint (~30ms response).
        // 200ms cadence = ~5 ticks/sec when prices move. Stays well under
        // Upstox rate limits. Full quotes refresh every 6th poll (~1.2s).
        let inFlight = false;
        let fullQuoteCounter = 0;
        this._pollInterval = setInterval(async () => {
            if (this.subscribed.size === 0 || inFlight) return;
            inFlight = true;
            const symbols = Array.from(this.subscribed);
            const metas = symbols.map(s => SYMBOL_MAP[s]).filter(Boolean);
            const keys = metas.map(m => m.key).join(',');
            try {
                // Every 6th poll, refresh full quote (OHLC + change). In between,
                // just hit /ltp for the fastest price-only updates.
                fullQuoteCounter++;
                if (fullQuoteCounter % 6 === 1) {
                    const quotes = await this.getQuotes(symbols);
                    for (const q of quotes) {
                        const prev = this.lastQuote.get(q.symbol);
                        if (!prev || prev.ltp !== q.ltp) {
                            this.lastQuote.set(q.symbol, q);
                            this.emit('tick', {
                                symbol: q.symbol, price: q.ltp,
                                change: q.change, changePercent: q.changePercent,
                                volume: q.volume, time: q.time,
                                high: q.high, low: q.low, open: q.open
                            });
                        }
                    }
                } else {
                    const j = await this._get('/v3/market-quote/ltp', { instrument_key: keys }, '3.0');
                    const data = j.data || {};
                    for (const sym of symbols) {
                        const meta = SYMBOL_MAP[sym];
                        if (!meta) continue;
                        const row = Object.entries(data).find(([k]) =>
                            k.replace(':', '|') === meta.key || k.endsWith(meta.key.split('|')[1])
                        )?.[1];
                        if (!row) continue;
                        const ltp = parseFloat(row.last_price || 0);
                        if (!ltp) continue;
                        const prev = this.lastQuote.get(sym) || {};
                        if (prev.ltp === ltp) continue;
                        // Use the previously fetched prev-day close (set by the full-quote
                        // path every 6th poll). NEVER fall back to ltp itself — that
                        // collapses change% to 0 and is what caused the topbar % flicker.
                        // If prevClose is unknown, preserve the previous tick's change%
                        // rather than emitting a fake 0.
                        const prevClose = prev.close || row.cp || null;
                        const change = prevClose ? (ltp - prevClose) : (prev.change ?? 0);
                        const changePercent = prevClose ? (change / prevClose) * 100 : (prev.changePercent ?? 0);
                        const updated = { ...prev, ltp, change, changePercent, time: Date.now() };
                        this.lastQuote.set(sym, updated);
                        this.emit('tick', { symbol: sym, price: ltp, change, changePercent, time: updated.time });
                    }
                }
            } catch (e) {
                if (!this._lastErrLog || Date.now() - this._lastErrLog > 60_000) {
                    console.error('[upstox poll]', e.message.slice(0, 100));
                    this._lastErrLog = Date.now();
                }
            } finally {
                inFlight = false;
            }
        }, 200);
    }

    stop() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._pollInterval = null;
    }
}

export const UPSTOX_SYMBOL_META = SYMBOL_MAP;

// Resample fine candles into coarser buckets aligned to wall-clock minutes.
// Used to synthesize 60min from 30min, and 3min from 1min.
function resample(candles, targetMin) {
    if (!candles?.length) return [];
    const bucketSec = targetMin * 60;
    const out = [];
    let bucket = null;
    for (const c of candles) {
        const start = Math.floor(c.time / bucketSec) * bucketSec;
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
