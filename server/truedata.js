import WebSocket from 'ws';
import { bus } from './agents/bus.js';
import { sysLog } from './db.js';

let ws = null;
let reconnectTimer = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 60000;
let isConnected = false;

// Standard symbols we care about
const SYMBOLS = ['NIFTY 50', 'NIFTY BANK', 'SENSEX'];

function connectTrueData() {
    if (ws) {
        try { ws.close(); } catch (e) {}
    }

    const port = process.env.TRUEDATA_WS_PORT || 8086;
    // Assuming a local TrueData Velocity proxy, or a remote host if specified
    const host = process.env.TRUEDATA_HOST || '127.0.0.1';
    const url = `ws://${host}:${port}`;
    
    sysLog('INFO', 'truedata', `Connecting to WebSocket at ${url}`);
    
    ws = new WebSocket(url);

    ws.on('open', () => {
        isConnected = true;
        backoffMs = 1000; // reset backoff
        sysLog('INFO', 'truedata', 'WebSocket connected successfully');

        // Send login if credentials are provided
        if (process.env.TRUEDATA_USERNAME && process.env.TRUEDATA_PASSWORD) {
            const loginReq = {
                method: 'login',
                userid: process.env.TRUEDATA_USERNAME,
                password: process.env.TRUEDATA_PASSWORD
            };
            ws.send(JSON.stringify(loginReq));
            sysLog('INFO', 'truedata', 'Sent login request');
        }

        // Subscribe to standard symbols
        const subReq = {
            method: 'addsymbols',
            symbols: SYMBOLS
        };
        ws.send(JSON.stringify(subReq));
        sysLog('INFO', 'truedata', `Subscribed to ${SYMBOLS.join(', ')}`);
        
        bus.publish('truedata:connected', { ts: Date.now() });
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            // TrueData often sends a confirmation or data payload
            // Parse out ticks
            if (msg.symbol && msg.last_price) {
                // Normalize symbol
                let sym = msg.symbol;
                if (sym.includes('NIFTY BANK')) sym = 'BANKNIFTY';
                else if (sym.includes('NIFTY')) sym = 'NIFTY';
                else if (sym.includes('SENSEX')) sym = 'SENSEX';
                
                const tick = {
                    symbol: sym,
                    close: parseFloat(msg.last_price),
                    high: parseFloat(msg.high || msg.last_price),
                    low: parseFloat(msg.low || msg.last_price),
                    open: parseFloat(msg.open || msg.last_price),
                    volume: parseInt(msg.volume || 0, 10),
                    ts: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
                    source: 'truedata'
                };
                
                // Route into the standard bus tick topic
                bus.publish(`tick:${sym}`, tick);
            }
        } catch (e) {
            // Unparseable or non-json message, ignore safely
        }
    });

    ws.on('error', (err) => {
        sysLog('ERROR', 'truedata', `WebSocket error: ${err.message}`);
        isConnected = false;
    });

    ws.on('close', (code, reason) => {
        isConnected = false;
        sysLog('WARN', 'truedata', `WebSocket closed: ${code} ${reason}`);
        bus.publish('truedata:disconnected', { ts: Date.now() });
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    sysLog('INFO', 'truedata', `Reconnecting in ${backoffMs}ms...`);
    reconnectTimer = setTimeout(() => {
        connectTrueData();
    }, backoffMs);
    
    // Exponential backoff
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
}

export function startTrueData() {
    connectTrueData();
}

export function stopTrueData() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
        ws.close();
        ws = null;
    }
}

export function getTrueDataStatus() {
    return { connected: isConnected, url: `ws://${process.env.TRUEDATA_HOST || '127.0.0.1'}:${process.env.TRUEDATA_WS_PORT || 8086}` };
}
