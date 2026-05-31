// server/kotak.js — Kotak Neo Trade API adapter (v2, per official Neo docs)
//
// Reference: official Kotak Neo Trade API documentation (Login with TOTP +
// MPIN validate → baseUrl → Quotes / Scripmaster / Orders).
//
// Flow:
//   1. POST mis.kotaksecurities.com/login/1.0/tradeApiLogin
//        headers: Authorization: <access_token>, neo-fin-key: neotradeapi
//        body:    { mobileNumber, ucc, totp }
//        → returns viewToken + viewSid
//   2. POST mis.kotaksecurities.com/login/1.0/tradeApiValidate
//        headers: Authorization: <access_token>, neo-fin-key: neotradeapi,
//                 sid: <viewSid>, Auth: <viewToken>
//        body:    { mpin }
//        → returns sessionToken + sessionSid + baseUrl
//   3. Use baseUrl + access_token for quotes & scripmaster.
//      Use baseUrl + sessionToken + sessionSid + neo-fin-key for trading.
//
// Access token comes from: Neo app/web → Invest → TradeAPI → API Dashboard
// (single token shown there — pass as PLAIN string in Authorization header,
//  NO "Bearer " prefix). Resetting it invalidates all sessions immediately.

import { EventEmitter } from 'events';
import * as OTPAuth from 'otpauth';

// Fixed login host (per official docs — never changes)
const LOGIN_HOST = 'https://mis.kotaksecurities.com';
const NEO_FIN_KEY = 'neotradeapi';

// Index → Kotak Neo "neosymbol" query mapping.
// For indices, use the CASE-SENSITIVE index name (e.g. "Nifty 50").
// For stocks/F&O instruments, use pSymbol from the scrip master.
const INDEX_QUERY_MAP = {
    NIFTY:      { query: 'nse_cm|Nifty 50',         lot_size: 25,  strike_gap: 50  },
    SENSEX:     { query: 'bse_cm|SENSEX',           lot_size: 10,  strike_gap: 100 },
    FINNIFTY:   { query: 'nse_cm|Nifty Fin Service', lot_size: 25, strike_gap: 50  },
    BANKNIFTY:  { query: 'nse_cm|Nifty Bank',       lot_size: 15,  strike_gap: 100 },
    BANKEX:     { query: 'bse_cm|BANKEX',           lot_size: 15,  strike_gap: 100 }
};

export class KotakProvider extends EventEmitter {
    constructor({ accessToken, consumerKey, mobile, mpin, totpSecret, ucc, ...legacy }) {
        super();
        // Accept either `accessToken` (new naming) or `consumerKey` (legacy from
        // earlier env templates) — they're the same value.
        const token = accessToken || consumerKey;
        if (!token) {
            throw new Error('Kotak provider needs an access token (Neo App → Invest → TradeAPI → API Dashboard)');
        }
        this.mode = 'live';
        this.broker = 'kotak';
        this.creds = {
            accessToken: token,
            mobile: mobile || '',
            mpin: mpin || '',
            totpSecret: totpSecret || '',
            ucc: ucc || ''
        };
        this.session = null;        // { sessionToken, sessionSid, baseUrl, dataCenter, ... }
        this.subscribed = new Set();
        this.lastQuote = new Map();
        this.scripMaster = { byToken: new Map(), byKey: new Map(), loadedAt: 0 };
        this.symbolMeta = INDEX_QUERY_MAP;
        this._pollInterval = null;
    }

    _generateTOTP() {
        if (!this.creds.totpSecret) throw new Error('TOTP secret not configured');
        const totp = new OTPAuth.TOTP({
            issuer: 'Kotak',
            label: 'Neo',
            algorithm: 'SHA1',
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(this.creds.totpSecret.replace(/\s/g, '').toUpperCase())
        });
        return totp.generate();
    }

    // ============================================================
    //  Login flow (TOTP → MPIN)
    // ============================================================
    async login() {
        if (!this.creds.mobile || !this.creds.mpin || !this.creds.totpSecret || !this.creds.ucc) {
            throw new Error(
                'Kotak login needs mobile + mpin + totpSecret + ucc. ' +
                'For market data only, set these in .env and we will obtain baseUrl. ' +
                'Required env: KOTAK_MOBILE, KOTAK_MPIN, KOTAK_TOTP_SECRET, KOTAK_UCC.'
            );
        }

        // STEP 1 — TOTP login → viewToken + viewSid
        const totp = this._generateTOTP();
        const r1 = await fetch(LOGIN_HOST + '/login/1.0/tradeApiLogin', {
            method: 'POST',
            headers: {
                'Authorization': this.creds.accessToken,
                'neo-fin-key': NEO_FIN_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                mobileNumber: this.creds.mobile,
                ucc: this.creds.ucc,
                totp
            })
        });
        const t1 = await r1.text();
        if (!r1.ok) {
            throw new Error(`Kotak tradeApiLogin ${r1.status}: ${t1.slice(0, 300)}`);
        }
        const j1 = JSON.parse(t1);
        const d1 = j1.data || j1;
        const viewToken = d1.token;
        const viewSid = d1.sid;
        if (!viewToken || !viewSid) {
            throw new Error('tradeApiLogin response missing token/sid: ' + t1.slice(0, 300));
        }

        // STEP 2 — MPIN validate → sessionToken + sessionSid + baseUrl
        const r2 = await fetch(LOGIN_HOST + '/login/1.0/tradeApiValidate', {
            method: 'POST',
            headers: {
                'Authorization': this.creds.accessToken,
                'neo-fin-key': NEO_FIN_KEY,
                'sid': viewSid,
                'Auth': viewToken,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ mpin: this.creds.mpin })
        });
        const t2 = await r2.text();
        if (!r2.ok) {
            throw new Error(`Kotak tradeApiValidate ${r2.status}: ${t2.slice(0, 300)}`);
        }
        const j2 = JSON.parse(t2);
        const d2 = j2.data || j2;
        const sessionToken = d2.token;
        const sessionSid = d2.sid;
        const baseUrl = (d2.baseUrl || '').replace(/\/$/, '');
        if (!sessionToken || !sessionSid || !baseUrl) {
            throw new Error('tradeApiValidate response missing token/sid/baseUrl: ' + t2.slice(0, 300));
        }

        this.session = {
            sessionToken,
            sessionSid,
            baseUrl,
            dataCenter: d2.dataCenter || '',
            greeting: d2.greetingName || '',
            issuedAt: Date.now(),
            // Tokens valid till end of trading day. Refresh proactively after 8h.
            expiresAt: Date.now() + 8 * 3600 * 1000
        };
        console.log(`[kotak] login OK. baseUrl=${baseUrl} dc=${d2.dataCenter || '?'} hi ${d2.greetingName || ''}`);
        return this.session;
    }

    async _ensureSession() {
        if (this.session && this.session.expiresAt > Date.now() + 60000) return this.session;
        return await this.login();
    }

    // For market-data endpoints (quotes, scripmaster) — Authorization with the
    // access token ONLY. NO neo-fin-key, NO Auth, NO Sid.
    _dataHeaders() {
        return {
            'Authorization': this.creds.accessToken,
            'Content-Type': 'application/json'
        };
    }

    // For trading endpoints (place/modify/cancel order) — full session.
    _tradeHeaders() {
        if (!this.session) throw new Error('No active Kotak session — call login() first');
        return {
            'Auth': this.session.sessionToken,
            'Sid': this.session.sessionSid,
            'neo-fin-key': NEO_FIN_KEY,
            'accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    // ============================================================
    //  Quotes
    // ============================================================
    // Endpoint: GET <baseUrl>/script-details/1.0/quotes/neosymbol/<query>/<filter>
    // Filters: all (default), 52W, scrip_details, circuit_limits, ohlc, oi, depth, ltp
    async _fetchNeoQuote(neoQuery, filter = 'all') {
        await this._ensureSession();
        // Per docs, "<query>" with comma-separated multiples becomes a path segment.
        // We do NOT URL-encode the pipe or comma — the docs show them raw in cURL examples.
        const url = `${this.session.baseUrl}/script-details/1.0/quotes/neosymbol/${neoQuery}/${filter}`;
        const r = await fetch(url, { method: 'GET', headers: this._dataHeaders() });
        const text = await r.text();
        if (!r.ok) throw new Error(`Kotak quote ${r.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
    }

    async getQuote(symbol) {
        const meta = INDEX_QUERY_MAP[symbol];
        if (!meta) throw new Error('Unknown symbol: ' + symbol);
        const j = await this._fetchNeoQuote(meta.query, 'all');
        // Response is an array of quote objects
        const row = Array.isArray(j) ? j[0] : (j.data?.[0] || j.data || j);
        if (!row) throw new Error('Empty quote response for ' + symbol);
        const ohlc = row.ohlc || {};
        return {
            symbol,
            ltp: parseFloat(row.ltp || row.last_traded_price || 0),
            open: parseFloat(ohlc.open || row.open || 0),
            high: parseFloat(ohlc.high || row.high || 0),
            low: parseFloat(ohlc.low || row.low || 0),
            close: parseFloat(ohlc.close || row.close || 0),
            volume: parseInt(row.last_volume || row.volume || 0, 10),
            change: parseFloat(row.change || 0),
            changePercent: parseFloat(row.per_change || 0),
            time: parseInt(row.lstup_time || (Date.now() / 1000), 10) * 1000
        };
    }

    // Bulk fetch — single call for multiple symbols (efficient)
    async getQuotes(symbols) {
        const metas = symbols.map(s => INDEX_QUERY_MAP[s]).filter(Boolean);
        if (metas.length === 0) return [];
        const query = metas.map(m => m.query).join(',');
        const j = await this._fetchNeoQuote(query, 'all');
        const rows = Array.isArray(j) ? j : (j.data || []);
        return rows.map((row, i) => {
            const sym = symbols[i];
            const ohlc = row.ohlc || {};
            return {
                symbol: sym,
                ltp: parseFloat(row.ltp || 0),
                open: parseFloat(ohlc.open || 0),
                high: parseFloat(ohlc.high || 0),
                low: parseFloat(ohlc.low || 0),
                close: parseFloat(ohlc.close || 0),
                volume: parseInt(row.last_volume || 0, 10),
                change: parseFloat(row.change || 0),
                changePercent: parseFloat(row.per_change || 0),
                time: parseInt(row.lstup_time || (Date.now() / 1000), 10) * 1000
            };
        });
    }

    // ============================================================
    //  Historical OHLC
    // ============================================================
    // Kotak Neo's REST API does NOT have a documented historical endpoint.
    // Fall back to Yahoo Finance (free, 15-min delayed for indices, fine for
    // multi-timeframe signal logic since we mainly need recent OHLC shape).
    async getHistorical(symbol, interval = '5minute', count = 200) {
        const yMap = {
            NIFTY: '^NSEI', SENSEX: '^BSESN',
            FINNIFTY: 'NIFTY_FIN_SERVICE.NS', BANKNIFTY: '^NSEBANK'
        };
        const ysym = yMap[symbol];
        if (!ysym) return [];
        const iMap = { '1minute': '1m', '5minute': '5m', '15minute': '15m', '30minute': '30m', '60minute': '60m', '1day': '1d' };
        const yInt = iMap[interval] || '5m';
        const rangeMap = { '1m': '1d', '5m': '5d', '15m': '5d', '30m': '5d', '60m': '1mo', '1d': '6mo' };
        const range = rangeMap[yInt];
        try {
            const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${yInt}&range=${range}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
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
            console.error('[kotak] historical fallback failed:', e.message);
            return [];
        }
    }

    // ============================================================
    //  Scripmaster — list daily CSV file paths, parse for F&O strikes
    // ============================================================
    async _loadScripMaster() {
        const oneDay = 24 * 3600 * 1000;
        if (this.scripMaster.loadedAt && Date.now() - this.scripMaster.loadedAt < oneDay) return;
        await this._ensureSession();
        try {
            const r = await fetch(`${this.session.baseUrl}/script-details/1.0/masterscrip/file-paths`, {
                method: 'GET', headers: this._dataHeaders()
            });
            const text = await r.text();
            if (!r.ok) throw new Error(`scripmaster ${r.status}: ${text.slice(0, 200)}`);
            const j = JSON.parse(text);
            const filePaths = j.data?.filesPaths || [];

            // We want nse_fo (NIFTY/FINNIFTY/BANKNIFTY options) and bse_fo (SENSEX/BANKEX options).
            const targets = filePaths.filter(p => /nse_fo|bse_fo/.test(p));
            for (const csvUrl of targets) {
                const csv = await (await fetch(csvUrl)).text();
                this._parseScripCSV(csv);
            }
            this.scripMaster.loadedAt = Date.now();
            console.log(`[kotak] scrip master loaded: ${this.scripMaster.byToken.size} F&O instruments`);
        } catch (e) {
            console.error('[kotak] scrip master load failed:', e.message);
        }
    }

    _parseScripCSV(csv) {
        const lines = csv.split(/\r?\n/);
        if (lines.length < 2) return;
        const header = lines[0].split(',').map(h => h.trim().toLowerCase());
        const idx = (name) => header.indexOf(name);
        const pSymIdx = idx('psymbol');
        const tSymIdx = idx('ptrdsymbol');
        const exchIdx = idx('pexchseg');
        const strikeIdx = idx('dstrike') !== -1 ? idx('dstrike') : idx('strike');
        const optIdx = idx('poptiontype') !== -1 ? idx('poptiontype') : idx('optiontype');
        const expiryIdx = idx('lexpirydate') !== -1 ? idx('lexpirydate') : idx('expiry');
        const lotIdx = idx('llotsize') !== -1 ? idx('llotsize') : idx('lotsize');
        const nameIdx = idx('pdesc') !== -1 ? idx('pdesc') : idx('name');

        for (let i = 1; i < lines.length; i++) {
            const row = lines[i].split(',');
            if (row.length < 5) continue;
            const pSym = row[pSymIdx]?.trim();
            const exch = row[exchIdx]?.trim();
            const optType = (row[optIdx] || '').trim().toUpperCase();
            if (!pSym || !exch || (optType !== 'CE' && optType !== 'PE')) continue;
            const entry = {
                pSymbol: pSym,
                tradingSymbol: row[tSymIdx]?.trim() || '',
                exchange: exch,
                strike: parseFloat(row[strikeIdx] || 0),
                type: optType,
                expiry: row[expiryIdx]?.trim() || '',
                lot: parseInt(row[lotIdx] || 0, 10),
                underlying: row[nameIdx]?.trim() || ''
            };
            this.scripMaster.byToken.set(`${exch}|${pSym}`, entry);
            const k = `${entry.underlying}|${entry.expiry}|${entry.strike}|${optType}`;
            this.scripMaster.byKey.set(k, entry);
        }
    }

    // ============================================================
    //  Option Chain — combine scripmaster + batch quote
    // ============================================================
    async getOptionChain(symbol, expiry) {
        await this._loadScripMaster();
        const indexNames = {
            NIFTY: ['NIFTY', 'NIFTY 50'],
            SENSEX: ['SENSEX', 'BSXOPT'],
            FINNIFTY: ['FINNIFTY', 'NIFTY FIN SERVICE'],
            BANKNIFTY: ['BANKNIFTY', 'NIFTY BANK']
        };
        const wantedNames = indexNames[symbol] || [symbol];
        const matches = [];
        for (const entry of this.scripMaster.byToken.values()) {
            if (!wantedNames.some(n => entry.underlying.toUpperCase().startsWith(n))) continue;
            if (expiry && entry.expiry !== expiry) continue;
            matches.push(entry);
        }
        if (matches.length === 0) return [];

        const expiries = [...new Set(matches.map(m => m.expiry))].sort();
        const chosenExpiry = expiry || expiries[0];
        const filtered = matches.filter(m => m.expiry === chosenExpiry);

        // Sort by strike, take ~30 strikes centered around ATM later in client.
        filtered.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));

        // Batch quote (max ~50 per call to stay sane)
        const out = [];
        for (let i = 0; i < filtered.length; i += 30) {
            const batch = filtered.slice(i, i + 30);
            const query = batch.map(e => `${e.exchange}|${e.pSymbol}`).join(',');
            try {
                const j = await this._fetchNeoQuote(query, 'all');
                const rows = Array.isArray(j) ? j : (j.data || []);
                rows.forEach((row, k) => {
                    const e = batch[k];
                    if (!e) return;
                    out.push({
                        strike: e.strike,
                        type: e.type,
                        expiry: e.expiry,
                        token: e.pSymbol,
                        ltp: parseFloat(row.ltp || 0),
                        oi: parseInt(row.total_buy || row.oi || 0, 10),
                        oiChange: 0,  // not in default response, would need /oi filter
                        iv: 0,        // not in default Kotak response
                        volume: parseInt(row.last_volume || 0, 10)
                    });
                });
            } catch (e) {
                console.error('[kotak] chain batch failed:', e.message);
            }
        }
        return out;
    }

    // ============================================================
    //  Polling-based subscription (WebSocket integration is a separate phase)
    // ============================================================
    subscribe(symbols) { symbols.forEach(s => this.subscribed.add(s)); this._ensurePolling(); }
    unsubscribe(symbols) { symbols.forEach(s => this.subscribed.delete(s)); }

    _ensurePolling() {
        if (this._pollInterval) return;
        this._pollInterval = setInterval(async () => {
            if (this.subscribed.size === 0) return;
            const symbols = Array.from(this.subscribed);
            try {
                const quotes = await this.getQuotes(symbols);
                for (const q of quotes) {
                    const prev = this.lastQuote.get(q.symbol);
                    if (!prev || prev.ltp !== q.ltp) {
                        this.lastQuote.set(q.symbol, q);
                        this.emit('tick', {
                            symbol: q.symbol, price: q.ltp,
                            change: q.change,
                            changePercent: q.changePercent,
                            volume: q.volume,
                            time: q.time
                        });
                    }
                }
            } catch (e) {
                console.error('[kotak poll]', e.message);
            }
        }, 2000);
    }

    stop() {
        if (this._pollInterval) clearInterval(this._pollInterval);
        this._pollInterval = null;
    }
}

// Exported meta — used by signal engine for lot size / strike gap
export const KOTAK_SYMBOL_META = Object.fromEntries(
    Object.keys(INDEX_QUERY_MAP).map(s => [s, INDEX_QUERY_MAP[s]])
);
