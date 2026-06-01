// server/indianapi.js — Hybrid market data provider
//
// indianapi.in's stock API gives us:
//   • Daily historical OHLC for individual stocks
//   • Live "top movers" — NSE/BSE most active, trending, 52-week high/low
//   • Individual stock fundamentals + analyst targets
//
// But it does NOT have:
//   • Real-time NIFTY/SENSEX index quotes (returns ETFs when asked)
//   • Intraday OHLC (only daily)
//   • Option chains with OI/IV
//
// So we hybrid it:
//   • Index quotes & intraday: Yahoo Finance (15-min delayed, free)
//   • Option chain: synthesized (until Upstox token unlocks real chain)
//   • Top movers / fundamentals: indianapi.in (real-time, our differentiator)
//
// This gets us REAL Indian market data flowing immediately for the
// learning/development phase. When the Upstox token arrives, we swap.

import { EventEmitter } from 'events';

const INDIANAPI_BASE = 'https://stock.indianapi.in';

// Lot sizes per SEBI revision effective Nov 2024 → current standard
const INDEX_META = {
    NIFTY:     { name: 'NIFTY 50',          yahoo: '^NSEI',                lot_size: 75, strike_gap: 50,  basePrice: 24856.30 },
    SENSEX:    { name: 'SENSEX',            yahoo: '^BSESN',               lot_size: 20, strike_gap: 100, basePrice: 81542.75 },
    FINNIFTY:  { name: 'NIFTY FIN SERVICE', yahoo: 'NIFTY_FIN_SERVICE.NS', lot_size: 65, strike_gap: 50,  basePrice: 23180.60 },
    BANKNIFTY: { name: 'NIFTY BANK',        yahoo: '^NSEBANK',             lot_size: 30, strike_gap: 100, basePrice: 51000.00 }
};

export class IndianApiProvider extends EventEmitter {
    constructor({ apiKey }) {
        super();
        if (!apiKey) throw new Error('IndianAPI provider requires INDIANAPI_KEY');
        this.mode = 'hybrid';
        this.broker = 'indianapi';
        this.apiKey = apiKey;
        this.subscribed = new Set();
        this.lastQuote = new Map();
        this.symbolMeta = INDEX_META;
        this._pollInterval = null;
        // tiny in-memory cache to avoid hammering Yahoo
        this._quoteCache = new Map();    // symbol → { quote, expiresAt }
        this._moversCache = null;        // { data, expiresAt }
        this._historicalCache = new Map();
    }

    // ============================================================
    //  Yahoo Finance — for live-ish index quotes (15-min delayed, free)
    // ============================================================
    async _yahooQuote(symbol) {
        const meta = INDEX_META[symbol];
        if (!meta) throw new Error('Unknown symbol: ' + symbol);
        const cached = this._quoteCache.get(symbol);
        if (cached && cached.expiresAt > Date.now()) return cached.quote;

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yahoo)}?interval=1m&range=1d`;
        try {
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!r.ok) throw new Error('yahoo ' + r.status);
            const j = await r.json();
            const result = j.chart?.result?.[0];
            if (!result) throw new Error('yahoo empty result');
            const m = result.meta || {};
            const price = m.regularMarketPrice || m.previousClose || meta.basePrice;
            const close = m.chartPreviousClose || m.previousClose || price;
            const quote = {
                symbol,
                ltp: price,
                open: m.regularMarketOpen || close,
                high: m.regularMarketDayHigh || price,
                low: m.regularMarketDayLow || price,
                close,
                volume: m.regularMarketVolume || 0,
                change: price - close,
                changePercent: close ? ((price - close) / close) * 100 : 0,
                time: (m.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000
            };
            this._quoteCache.set(symbol, { quote, expiresAt: Date.now() + 30000 }); // 30s
            return quote;
        } catch (e) {
            // Fallback: previous cached quote, even if expired
            if (cached) return cached.quote;
            // last resort: synthetic
            return {
                symbol, ltp: meta.basePrice, open: meta.basePrice, high: meta.basePrice,
                low: meta.basePrice, close: meta.basePrice, volume: 0,
                change: 0, changePercent: 0, time: Date.now()
            };
        }
    }

    async _yahooHistorical(symbol, interval, count) {
        const meta = INDEX_META[symbol];
        if (!meta) return [];

        // Yahoo doesn't natively support 3m. Fetch 1m and resample to 3m.
        if (interval === '3minute') {
            const oneMin = await this._yahooHistorical(symbol, '1minute', count * 3 + 30);
            return this._resampleCandles(oneMin, 3, count);
        }

        const iMap = { '1minute': '1m', '5minute': '5m', '15minute': '15m', '30minute': '30m', '60minute': '60m', '1day': '1d' };
        const yInt = iMap[interval] || '5m';
        // Yahoo limits: 1m max range = 7d, 5m/15m/30m max = 60d, 60m max = 730d, 1d unlimited.
        // After-hours / weekends "range=1d" can return empty, so we use widest safe window.
        const rangeMap = { '1m': '5d', '5m': '30d', '15m': '60d', '30m': '60d', '60m': '6mo', '1d': '2y' };
        const range = rangeMap[yInt] || '5d';
        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.yahoo)}?interval=${yInt}&range=${range}`;
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!r.ok) return [];
            const j = await r.json();
            const result = j.chart?.result?.[0];
            if (!result) return [];
            const times = result.timestamp || [];
            const q = result.indicators?.quote?.[0] || {};
            const out = [];
            for (let i = 0; i < times.length; i++) {
                if (q.open?.[i] == null || q.close?.[i] == null) continue;
                out.push({
                    time: times[i],
                    open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i],
                    volume: q.volume?.[i] || 0
                });
            }
            return out.slice(-count);
        } catch (e) {
            console.error('[indianapi] yahoo historical failed:', e.message);
            return [];
        }
    }

    // ============================================================
    //  Server-side candle resampler
    //  Groups every `factor` base candles into one larger candle.
    //  Open = first.open, High = max high, Low = min low, Close = last.close,
    //  Volume = sum, Time = first.time of the group.
    // ============================================================
    _resampleCandles(candles, factor, maxCount) {
        if (!candles?.length || factor <= 1) return candles?.slice?.(-maxCount) || [];
        const out = [];
        // Align groups to "round" minute boundaries so e.g. 3m candles start at :00,:03,:06.
        // We compute group key from time (in seconds) divided by groupSeconds.
        // Assumes uniform base interval; with Yahoo 1m this holds.
        const baseSec = (candles[1]?.time && candles[0]?.time) ? (candles[1].time - candles[0].time) : 60;
        const groupSec = baseSec * factor;
        let bucket = null;
        for (const c of candles) {
            const bucketTime = Math.floor(c.time / groupSec) * groupSec;
            if (!bucket || bucket.time !== bucketTime) {
                if (bucket) out.push(bucket);
                bucket = {
                    time: bucketTime,
                    open: c.open, high: c.high, low: c.low, close: c.close,
                    volume: c.volume || 0
                };
            } else {
                if (c.high > bucket.high) bucket.high = c.high;
                if (c.low < bucket.low) bucket.low = c.low;
                bucket.close = c.close;
                bucket.volume += c.volume || 0;
            }
        }
        if (bucket) out.push(bucket);
        return maxCount ? out.slice(-maxCount) : out;
    }

    // ============================================================
    //  indianapi.in — REST helper
    // ============================================================
    async _indianGet(path, params = {}) {
        const qs = new URLSearchParams(params).toString();
        const url = `${INDIANAPI_BASE}${path}${qs ? '?' + qs : ''}`;
        const r = await fetch(url, { headers: { 'X-Api-Key': this.apiKey } });
        if (!r.ok) {
            const text = await r.text();
            throw new Error(`indianapi ${path} ${r.status}: ${text.slice(0, 200)}`);
        }
        return r.json();
    }

    // ============================================================
    //  Public provider interface
    // ============================================================

    async getQuote(symbol) {
        // Indices → Yahoo (only option since indianapi doesn't have them)
        if (INDEX_META[symbol]) return this._yahooQuote(symbol);
        // Individual stock → indianapi
        try {
            const j = await this._indianGet('/stock', { name: symbol });
            const cp = j.currentPrice || j.current_price || {};
            const ltp = parseFloat(cp.NSE || cp.BSE || cp.price || 0);
            const close = parseFloat(cp.previousClose || j.previousClose || ltp);
            return {
                symbol, ltp, open: parseFloat(j.open || ltp), high: parseFloat(j.high || ltp),
                low: parseFloat(j.low || ltp), close,
                volume: parseInt(j.volume || 0, 10),
                change: ltp - close,
                changePercent: close ? ((ltp - close) / close) * 100 : 0,
                time: Date.now()
            };
        } catch (e) {
            throw new Error(`Quote for ${symbol} unavailable: ${e.message}`);
        }
    }

    async getHistorical(symbol, interval = '5minute', count = 200) {
        // Intraday intervals → Yahoo (indianapi only has daily periods)
        if (interval !== '1day') return this._yahooHistorical(symbol, interval, count);

        // Daily for stocks → indianapi
        if (INDEX_META[symbol]) return this._yahooHistorical(symbol, '1day', count);

        // Daily for individual stock via indianapi
        try {
            const period = count <= 30 ? '1m' : count <= 180 ? '6m' : count <= 365 ? '1yr' : '3yr';
            const j = await this._indianGet('/historical_data', { stock_name: symbol, period, filter: 'price' });
            const series = j.datasets?.[0]?.values || j.values || [];
            // Convert to OHLC shape (indianapi historical is often just close prices)
            return series.slice(-count).map((row, i) => {
                const [date, price] = Array.isArray(row) ? row : [row.date, row.price];
                const p = parseFloat(price);
                return {
                    time: Math.floor(new Date(date).getTime() / 1000),
                    open: p, high: p, low: p, close: p, volume: 0
                };
            });
        } catch (e) {
            console.error('[indianapi] daily historical failed:', e.message);
            return [];
        }
    }

    async getOptionChain(symbol, expiry) {
        // Neither indianapi nor Yahoo have NIFTY/SENSEX option chains.
        // Synthesize a plausible one from spot price (same as backtester).
        const q = await this.getQuote(symbol);
        const meta = INDEX_META[symbol];
        if (!meta) return [];
        const spot = q.ltp;
        const gap = meta.strike_gap;
        const atm = Math.round(spot / gap) * gap;
        const out = [];
        const ivBase = 14 + Math.random() * 3;
        for (let i = -8; i <= 8; i++) {
            const strike = atm + i * gap;
            const dist = Math.abs(i);
            const intrinsicCE = Math.max(0, spot - strike);
            const intrinsicPE = Math.max(0, strike - spot);
            const timeValue = Math.max(8, 70 / (1 + dist * 0.35));
            const oi = Math.floor((900000 + Math.random() * 1500000) / (1 + dist * 0.25));
            const iv = ivBase + dist * 0.4;
            out.push({
                strike, type: 'CE',
                ltp: parseFloat((intrinsicCE + timeValue).toFixed(2)),
                oi, oiChange: Math.floor((Math.random() - 0.5) * 200000),
                iv: parseFloat(iv.toFixed(2)),
                volume: Math.floor(Math.random() * 500000),
                expiry: expiry || '2026-06-26'
            });
            out.push({
                strike, type: 'PE',
                ltp: parseFloat((intrinsicPE + timeValue).toFixed(2)),
                oi, oiChange: Math.floor((Math.random() - 0.5) * 200000),
                iv: parseFloat(iv.toFixed(2)),
                volume: Math.floor(Math.random() * 500000),
                expiry: expiry || '2026-06-26'
            });
        }
        return out;
    }

    // ============================================================
    //  Bonus capabilities (exposed via new endpoints in index.js)
    // ============================================================
    async getTopMovers() {
        if (this._moversCache && this._moversCache.expiresAt > Date.now()) return this._moversCache.data;
        try {
            const [nse, bse, trending] = await Promise.all([
                this._indianGet('/NSE_most_active').catch(() => []),
                this._indianGet('/BSE_most_active').catch(() => []),
                this._indianGet('/trending').catch(() => ({}))
            ]);
            const data = {
                nseMostActive: (Array.isArray(nse) ? nse : []).slice(0, 10).map(this._normalizeMover),
                bseMostActive: (Array.isArray(bse) ? bse : []).slice(0, 10).map(this._normalizeMover),
                topGainers: (trending.trending_stocks?.top_gainers || []).slice(0, 5).map(this._normalizeMover),
                topLosers: (trending.trending_stocks?.top_losers || []).slice(0, 5).map(this._normalizeMover),
                fetchedAt: Date.now()
            };
            this._moversCache = { data, expiresAt: Date.now() + 60000 }; // 1-min cache
            return data;
        } catch (e) {
            console.error('[indianapi] top movers failed:', e.message);
            return { nseMostActive: [], bseMostActive: [], topGainers: [], topLosers: [] };
        }
    }

    _normalizeMover(row) {
        return {
            ticker: row.ticker || row.ticker_id || row.symbol,
            company: row.company || row.company_name || row.name,
            price: parseFloat(row.price || 0),
            change: parseFloat(row.net_change || row.change || 0),
            changePercent: parseFloat(row.percent_change || row.percentChange || 0),
            volume: parseInt(row.volume || 0, 10)
        };
    }

    async getStockDetail(name) {
        try {
            return await this._indianGet('/stock', { name });
        } catch (e) {
            return { error: e.message };
        }
    }

    async getFiftyTwoWeek() {
        try {
            return await this._indianGet('/fetch_52_week_high_low_data');
        } catch (e) {
            return { error: e.message };
        }
    }

    // ============================================================
    //  Live tick polling (Yahoo for indices, every 3s)
    // ============================================================
    subscribe(symbols) { symbols.forEach(s => this.subscribed.add(s)); this._ensurePolling(); }
    unsubscribe(symbols) { symbols.forEach(s => this.subscribed.delete(s)); }

    _ensurePolling() {
        if (this._pollInterval) return;
        // Fire an immediate tick so UI doesn't wait 3 seconds for first paint
        setImmediate(() => this._pollOnce());
        this._pollInterval = setInterval(() => this._pollOnce(), 3000);
        this._lastEmit = new Map();
    }

    async _pollOnce() {
        for (const sym of this.subscribed) {
            try {
                this._quoteCache.delete(sym);
                const q = await this.getQuote(sym);
                const prev = this.lastQuote.get(sym);
                const lastEmitAt = this._lastEmit.get(sym) || 0;
                const now = Date.now();
                // Emit on: first quote, price change, OR every 15s as heartbeat
                const shouldEmit = !prev || prev.ltp !== q.ltp || (now - lastEmitAt) > 15000;
                if (shouldEmit) {
                    this.lastQuote.set(sym, q);
                    this._lastEmit.set(sym, now);
                    this.emit('tick', {
                        symbol: sym, price: q.ltp,
                        change: q.change,
                        changePercent: q.changePercent,
                        volume: q.volume,
                        time: q.time
                    });
                }
            } catch (e) {
                console.error('[indianapi tick]', sym, e.message);
            }
        }
    }

    stop() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._pollInterval = null;
    }
}

export const INDIANAPI_SYMBOL_META = INDEX_META;
