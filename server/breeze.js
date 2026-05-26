// server/breeze.js — Breeze Connect (ICICI Direct API) adapter
// Falls back to mock provider if creds are missing or USE_MOCK=true.
//
// Breeze docs: https://api.icicidirect.com/breezeapi/documents/index.html
//
// Auth model: every request must include X-Checksum (sha256 of timestamp+jsonBody+secret),
// X-Timestamp (ISO 8601), X-AppKey, X-SessionToken. Session token is obtained daily
// via web login flow (https://api.icicidirect.com/apiuser/login?api_key=<your_key>)
// then exchanged via customer_details endpoint.

import crypto from 'crypto';
import { EventEmitter } from 'events';

const BASE = 'https://api.icicidirect.com/breezeapi/api/v1';

// -------- Symbol mapping (NIFTY/SENSEX for Breeze) --------
const SYMBOL_MAP = {
    NIFTY: { exchange: 'NSE', stock_code: 'NIFTY', lot_size: 25, strike_gap: 50 },
    SENSEX: { exchange: 'BSE', stock_code: 'BSESEN', lot_size: 10, strike_gap: 100 },
    FINNIFTY: { exchange: 'NSE', stock_code: 'NIFFIN', lot_size: 25, strike_gap: 50 }
};

class BreezeProvider extends EventEmitter {
    constructor({ apiKey, apiSecret, sessionToken }) {
        super();
        this.mode = 'live';
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.sessionToken = sessionToken;
        this.subscribed = new Set();
        this.lastQuote = new Map();
        this._startPolling();
    }

    _sign(body, ts) {
        const raw = ts + body + this.apiSecret;
        return crypto.createHash('sha256').update(raw).digest('hex');
    }

    async _post(path, payload) {
        const body = JSON.stringify(payload || {});
        const ts = new Date().toISOString();
        const res = await fetch(BASE + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Checksum': 'token ' + this._sign(body, ts),
                'X-Timestamp': ts,
                'X-AppKey': this.apiKey,
                'X-SessionToken': this.sessionToken
            },
            body
        });
        if (!res.ok) throw new Error(`Breeze ${path} ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (data.Status && data.Status !== 200) {
            throw new Error(`Breeze ${path} error: ${data.Error || JSON.stringify(data)}`);
        }
        return data.Success || data;
    }

    async getQuote(symbol) {
        const m = SYMBOL_MAP[symbol];
        if (!m) throw new Error('Unknown symbol: ' + symbol);
        const data = await this._post('/quotes', {
            stock_code: m.stock_code,
            exchange_code: m.exchange,
            product_type: 'cash'
        });
        const q = Array.isArray(data) ? data[0] : data;
        return {
            symbol,
            ltp: parseFloat(q.ltp || q.last_traded_price),
            open: parseFloat(q.open),
            high: parseFloat(q.high),
            low: parseFloat(q.low),
            close: parseFloat(q.previous_close || q.close),
            volume: parseInt(q.total_quantity_traded || q.volume || 0, 10),
            time: Date.now()
        };
    }

    async getHistorical(symbol, interval = '5minute', count = 200) {
        const m = SYMBOL_MAP[symbol];
        if (!m) throw new Error('Unknown symbol: ' + symbol);
        const intervalMap = { '1minute': '1minute', '5minute': '5minute', '30minute': '30minute', '1day': '1day' };
        const breezeInterval = intervalMap[interval] || '5minute';
        const intervalSec = { '1minute': 60, '5minute': 300, '30minute': 1800, '1day': 86400 }[breezeInterval];
        const toDate = new Date();
        const fromDate = new Date(toDate.getTime() - count * intervalSec * 1000);
        const data = await this._post('/historicalcharts', {
            interval: breezeInterval,
            from_date: fromDate.toISOString(),
            to_date: toDate.toISOString(),
            stock_code: m.stock_code,
            exchange_code: m.exchange,
            product_type: 'cash'
        });
        const candles = (Array.isArray(data) ? data : (data?.data || []))
            .map(c => ({
                time: Math.floor(new Date(c.datetime).getTime() / 1000),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                volume: parseInt(c.volume || 0, 10)
            }))
            .filter(c => Number.isFinite(c.close));
        return candles;
    }

    async getOptionChain(symbol, expiry) {
        const m = SYMBOL_MAP[symbol];
        if (!m) throw new Error('Unknown symbol: ' + symbol);
        const data = await this._post('/optionchain', {
            stock_code: m.stock_code,
            exchange_code: m.exchange === 'BSE' ? 'BFO' : 'NFO',
            product_type: 'options',
            expiry_date: expiry
        });
        const rows = Array.isArray(data) ? data : (data?.data || []);
        return rows.map(r => ({
            strike: parseFloat(r.strike_price),
            type: r.right ? r.right.toUpperCase() : (r.option_type || ''),
            ltp: parseFloat(r.ltp || r.last_traded_price || 0),
            oi: parseInt(r.open_interest || 0, 10),
            oiChange: parseInt(r.change_in_oi || 0, 10),
            iv: parseFloat(r.implied_volatility || 0),
            volume: parseInt(r.total_quantity_traded || 0, 10),
            expiry: r.expiry_date
        }));
    }

    subscribe(symbols) { symbols.forEach(s => this.subscribed.add(s)); }
    unsubscribe(symbols) { symbols.forEach(s => this.subscribed.delete(s)); }

    // Lightweight polling for live ticks (every 2s).
    // For full WS streaming, install breeze-connect Python SDK or implement
    // Socket.IO client per Breeze docs. Polling is good enough for signals.
    _startPolling() {
        this._pollInterval = setInterval(async () => {
            for (const sym of this.subscribed) {
                try {
                    const q = await this.getQuote(sym);
                    const prev = this.lastQuote.get(sym);
                    if (!prev || prev.ltp !== q.ltp) {
                        this.lastQuote.set(sym, q);
                        this.emit('tick', {
                            symbol: sym, price: q.ltp,
                            change: q.ltp - q.close,
                            changePercent: ((q.ltp - q.close) / q.close) * 100,
                            volume: q.volume,
                            time: q.time
                        });
                    }
                } catch (e) {
                    console.error('[breeze poll]', sym, e.message);
                }
            }
        }, 2000);
    }
}

// -------- Mock Provider --------
// Uses GBM simulation so the frontend can develop without live creds.
class MockProvider extends EventEmitter {
    constructor() {
        super();
        this.mode = 'mock';
        this.basePrices = { NIFTY: 24856.30, SENSEX: 81542.75, FINNIFTY: 23180.60 };
        this.prices = { ...this.basePrices };
        this.subscribed = new Set();
        this.histories = {};
        for (const sym of Object.keys(this.basePrices)) {
            this.histories[sym] = this._seedHistory(sym, 300);
        }
        this._startTicker();
    }

    _randn() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    _step(sym) {
        const base = this.basePrices[sym];
        const vol = 0.0007;
        const drift = 0.000005;
        const dW = this._randn();
        const meanRev = 0.02 * (base - this.prices[sym]) / base;
        const ret = drift + meanRev + vol * dW;
        this.prices[sym] = this.prices[sym] * (1 + ret);
        return this.prices[sym];
    }

    _seedHistory(sym, count) {
        const candles = [];
        const now = Math.floor(Date.now() / 1000);
        const step = 300; // 5min
        for (let i = 0; i < count; i++) {
            let o = this.prices[sym];
            let h = o, l = o;
            for (let j = 0; j < 30; j++) {
                this._step(sym);
                if (this.prices[sym] > h) h = this.prices[sym];
                if (this.prices[sym] < l) l = this.prices[sym];
            }
            const close = this.prices[sym];
            const volBase = sym === 'NIFTY' ? 280000 : sym === 'SENSEX' ? 95000 : 180000;
            candles.push({
                time: now - (count - i) * step,
                open: o, high: h, low: l, close,
                volume: Math.floor(volBase * (0.6 + Math.random()))
            });
        }
        return candles;
    }

    async getQuote(symbol) {
        const h = this.histories[symbol] || [];
        const last = h[h.length - 1];
        const prev = h[h.length - 2] || last;
        return {
            symbol,
            ltp: this.prices[symbol],
            open: last?.open || this.prices[symbol],
            high: last?.high || this.prices[symbol],
            low: last?.low || this.prices[symbol],
            close: prev?.close || this.prices[symbol],
            volume: last?.volume || 0,
            time: Date.now()
        };
    }

    async getHistorical(symbol, interval = '5minute', count = 200) {
        const h = this.histories[symbol] || [];
        return h.slice(-count);
    }

    async getOptionChain(symbol, expiry) {
        const spot = this.prices[symbol];
        const gap = symbol === 'SENSEX' ? 100 : 50;
        const atm = Math.round(spot / gap) * gap;
        const out = [];
        for (let i = -7; i <= 7; i++) {
            const strike = atm + i * gap;
            const dist = Math.abs(i);
            const intrinsicCall = Math.max(0, spot - strike);
            const intrinsicPut = Math.max(0, strike - spot);
            const timeValue = Math.max(8, 80 / (1 + dist * 0.4));
            const callOI = Math.floor((900000 + Math.random() * 1800000) / (1 + dist * 0.25));
            const putOI = Math.floor((900000 + Math.random() * 1800000) / (1 + dist * 0.25));
            const iv = 12 + Math.random() * 6 + dist * 0.4;
            out.push({ strike, type: 'CE', ltp: parseFloat((intrinsicCall + timeValue).toFixed(2)), oi: callOI, oiChange: Math.floor((Math.random() - 0.45) * 200000), iv: parseFloat(iv.toFixed(2)), volume: Math.floor(Math.random() * 500000), expiry });
            out.push({ strike, type: 'PE', ltp: parseFloat((intrinsicPut + timeValue).toFixed(2)), oi: putOI, oiChange: Math.floor((Math.random() - 0.45) * 200000), iv: parseFloat(iv.toFixed(2)), volume: Math.floor(Math.random() * 500000), expiry });
        }
        return out;
    }

    subscribe(symbols) { symbols.forEach(s => this.subscribed.add(s)); }
    unsubscribe(symbols) { symbols.forEach(s => this.subscribed.delete(s)); }

    _startTicker() {
        this._interval = setInterval(() => {
            for (const sym of this.subscribed) {
                const prev = this.prices[sym];
                this._step(sym);
                const last = this.histories[sym][this.histories[sym].length - 1];
                this.emit('tick', {
                    symbol: sym, price: this.prices[sym],
                    change: this.prices[sym] - prev,
                    changePercent: ((this.prices[sym] - prev) / prev) * 100,
                    volume: last?.volume || 0,
                    time: Date.now()
                });
            }
        }, 600);

        // Append new candle every 30 seconds (mock 5m candle compressed for visibility)
        this._candleInterval = setInterval(() => {
            for (const sym of Object.keys(this.histories)) {
                const h = this.histories[sym];
                const lastCandle = h[h.length - 1];
                const time = lastCandle.time + 300;
                const open = this.prices[sym];
                let high = open, low = open;
                for (let i = 0; i < 30; i++) {
                    this._step(sym);
                    if (this.prices[sym] > high) high = this.prices[sym];
                    if (this.prices[sym] < low) low = this.prices[sym];
                }
                const close = this.prices[sym];
                const volBase = sym === 'NIFTY' ? 280000 : sym === 'SENSEX' ? 95000 : 180000;
                h.push({ time, open, high, low, close, volume: Math.floor(volBase * (0.6 + Math.random())) });
                if (h.length > 500) h.shift();
            }
        }, 30000);
    }
}

export function createProvider({ apiKey, apiSecret, sessionToken, useMock }) {
    if (useMock || !apiKey || !apiSecret || !sessionToken) {
        if (!useMock) console.warn('[provider] Breeze creds missing — falling back to mock');
        return new MockProvider();
    }
    return new BreezeProvider({ apiKey, apiSecret, sessionToken });
}

export { SYMBOL_MAP };
