// server/index.js — QuantEdge backend entry point
// Express REST + WebSocket relay. Talks to Breeze Connect or mock provider.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createProvider } from './breeze.js';
import { SignalEngine } from './signal.js';

const PORT = parseInt(process.env.PORT || '4300', 10);
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5180';

const app = express();
app.use(cors({ origin: WEB_ORIGIN.split(','), credentials: false }));
app.use(express.json());

const provider = createProvider({
    apiKey: process.env.BREEZE_API_KEY,
    apiSecret: process.env.BREEZE_API_SECRET,
    sessionToken: process.env.BREEZE_SESSION_TOKEN,
    useMock: process.env.USE_MOCK !== 'false'
});

const engine = new SignalEngine();

// --- REST endpoints ---
app.get('/api/health', (req, res) => {
    res.json({ ok: true, mode: provider.mode, time: Date.now() });
});

app.get('/api/quote/:symbol', async (req, res) => {
    try {
        const quote = await provider.getQuote(req.params.symbol);
        res.json(quote);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/historical/:symbol', async (req, res) => {
    try {
        const interval = req.query.interval || '5minute';
        const count = parseInt(req.query.count || '200', 10);
        const candles = await provider.getHistorical(req.params.symbol, interval, count);
        res.json(candles);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/option-chain/:symbol', async (req, res) => {
    try {
        const chain = await provider.getOptionChain(req.params.symbol, req.query.expiry);
        res.json(chain);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/signal/evaluate', async (req, res) => {
    try {
        const { symbol, candles, currentPrice, chain, accountSize, riskPercent } = req.body;
        const signal = engine.evaluate({ symbol, candles, currentPrice, chain, accountSize, riskPercent });
        res.json(signal);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WebSocket relay ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    const subs = new Set();
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
                msg.symbols.forEach(s => subs.add(s));
                provider.subscribe(msg.symbols);
            } else if (msg.type === 'unsubscribe' && Array.isArray(msg.symbols)) {
                msg.symbols.forEach(s => subs.delete(s));
                provider.unsubscribe(msg.symbols);
            }
        } catch (_) {}
    });
    const onTick = (tick) => {
        if (subs.has(tick.symbol) && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'tick', ...tick }));
        }
    };
    provider.on('tick', onTick);
    ws.on('close', () => {
        provider.off('tick', onTick);
        subs.forEach(s => provider.unsubscribe([s]));
    });
    ws.send(JSON.stringify({ type: 'hello', mode: provider.mode }));
});

server.listen(PORT, () => {
    console.log(`[QuantEdge] backend listening on http://localhost:${PORT} (mode: ${provider.mode})`);
});
