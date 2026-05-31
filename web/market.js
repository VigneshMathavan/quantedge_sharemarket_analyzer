// market.js — Frontend market data client (REST + WebSocket)
// Talks to the QuantEdge backend.

class MarketClient {
    constructor(backendUrl) {
        this.setBackend(backendUrl);
        this.ws = null;
        this.subs = new Set();
        this.listeners = { tick: [], hello: [], close: [], open: [] };
        this.mode = 'unknown';
        this._reconnectTimer = null;
        this._reconnectDelay = 1000;
    }

    setBackend(url) {
        this.backend = (url || '').replace(/\/$/, '');
        // WebSocket URL — Vercel rewrites are HTTP-only, can't proxy WS.
        // In production, connect directly to Railway. Use window.QE_WS_URL
        // override if set, otherwise auto-detect.
        if (window.QE_WS_URL) {
            this.wsUrl = window.QE_WS_URL;
        } else if (this.backend) {
            // Local dev — derive WS from explicit backend URL
            this.wsUrl = this.backend.replace(/^http/, 'ws') + '/ws';
        } else {
            // Production — must hit Railway directly (Vercel can't proxy WS)
            const host = window.location.hostname;
            const isVercel = host.endsWith('.vercel.app');
            if (isVercel) {
                this.wsUrl = 'wss://quantedgesharemarketanalyzer-production.up.railway.app/ws';
            } else {
                // Custom domain or other host — try same origin
                const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                this.wsUrl = `${wsProto}//${window.location.host}/ws`;
            }
        }
    }

    on(event, cb) { this.listeners[event]?.push(cb); }

    _emit(event, payload) {
        (this.listeners[event] || []).forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } });
    }

    async fetchJSON(path) {
        const res = await fetch(this.backend + path);
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        return res.json();
    }

    async postJSON(path, body) {
        const res = await fetch(this.backend + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`${path} ${res.status}`);
        return res.json();
    }

    async health() {
        const h = await this.fetchJSON('/api/health');
        this.mode = h.mode;
        return h;
    }

    async getQuote(symbol) { return this.fetchJSON(`/api/quote/${symbol}`); }

    async getHistorical(symbol, interval = '5minute', count = 200) {
        return this.fetchJSON(`/api/historical/${symbol}?interval=${interval}&count=${count}`);
    }

    async getOptionChain(symbol, expiry) {
        const q = expiry ? `?expiry=${encodeURIComponent(expiry)}` : '';
        return this.fetchJSON(`/api/option-chain/${symbol}${q}`);
    }

    async evaluateSignal(payload) {
        return this.postJSON('/api/signal/evaluate', payload);
    }

    connectWS() {
        if (this.ws && this.ws.readyState === 1) return;
        try { this.ws?.close(); } catch (_) {}
        this.ws = new WebSocket(this.wsUrl);
        this.ws.onopen = () => {
            this._reconnectDelay = 1000;
            this._emit('open');
            if (this.subs.size > 0) {
                this.ws.send(JSON.stringify({ type: 'subscribe', symbols: Array.from(this.subs) }));
            }
        };
        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'tick') this._emit('tick', msg);
                else if (msg.type === 'hello') {
                    this.mode = msg.mode;
                    this._emit('hello', msg);
                }
            } catch (_) {}
        };
        this.ws.onclose = () => {
            this._emit('close');
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = setTimeout(() => this.connectWS(), this._reconnectDelay);
            this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 8000);
        };
        this.ws.onerror = () => { try { this.ws.close(); } catch (_) {} };
    }

    subscribe(symbols) {
        symbols.forEach(s => this.subs.add(s));
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'subscribe', symbols }));
        }
    }

    unsubscribe(symbols) {
        symbols.forEach(s => this.subs.delete(s));
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'unsubscribe', symbols }));
        }
    }
}

window.MarketClient = MarketClient;
