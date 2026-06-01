// server/index.js — QuantEdge backend entry point
// Express REST + WebSocket relay. Talks to Breeze Connect or mock provider.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createProvider as createBreezeOrMockProvider } from './breeze.js';
import { KotakProvider } from './kotak.js';
import { UpstoxProvider } from './upstox.js';
import { IndianApiProvider } from './indianapi.js';
import { history } from './history.js';
import { StrategyOrchestrator } from './strategies/base.js';
import { orbStrategy } from './strategies/orb.js';
import { vwapContinuationStrategy } from './strategies/vwap-continuation.js';
import { supertrendEmaStrategy } from './strategies/supertrend-ema.js';
import { rsiReversionStrategy } from './strategies/rsi-reversion.js';
import { bbSqueezeStrategy } from './strategies/bb-squeeze.js';
import { momentumBurstStrategy } from './strategies/momentum-burst.js';
import { rangeExpansionStrategy } from './strategies/range-expansion.js';
import { insideBarStrategy } from './strategies/inside-bar.js';
import { vwapCrossStrategy } from './strategies/vwap-cross.js';
import { emaPullbackStrategy } from './strategies/ema-pullback.js';
import { volumeClimaxStrategy } from './strategies/volume-climax.js';
import { cprBreakoutStrategy, cprReversalStrategy } from './strategies/cpr-strategy.js';
import { buildActionableSignal } from './strategies/signal-builder.js';
import { tracker } from './active-trade.js';
import { checkEventGate, nextEvent } from './strategies/event-gate.js';
import { adaptiveWeights } from './strategies/adaptive-weights.js';
import { winProbModel } from './strategies/win-prob.js';
import { news } from './news.js';
import { computeSR, detectOIWalls } from './levels.js';
import { CandleCache } from './candle-cache.js';
import { pathForecaster } from './path-forecaster.js';
import { mountUpstoxOAuth } from './upstox-oauth.js';
import { startWeeklyScheduler, runRetrain } from './auto-retrain.js';
import { classifyRegime } from './regime-engine.js';
import { approveTrade } from './approval-engine.js';
import { calibrator } from './calibrator.js';
import { blackScholes, nextExpiryMs, daysToExpiry } from './greeks.js';
import { detectGammaBlast } from './gamma-blast.js';
import { scanStrikes } from './strike-scanner.js';
import { buildProfitPlaybook } from './profit-playbook.js';
import { computeAllCPR, cprProximity } from './cpr.js';
import { detectPatterns, estimateCandleProgress, scanAllCandles } from './pattern-detector.js';

const orchestrator = new StrategyOrchestrator([
    orbStrategy,
    vwapContinuationStrategy,
    supertrendEmaStrategy,
    rsiReversionStrategy,
    bbSqueezeStrategy,
    momentumBurstStrategy,
    rangeExpansionStrategy,
    insideBarStrategy,
    vwapCrossStrategy,
    emaPullbackStrategy,
    volumeClimaxStrategy,
    cprBreakoutStrategy,
    cprReversalStrategy
]);
import { SignalEngine } from './signal.js';
import { SignalEngineV2 } from './signal2.js';

const PORT = parseInt(process.env.PORT || '4300', 10);
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5180';
const ML_URL = process.env.ML_URL || 'http://localhost:4400';
const ML_ENABLED = process.env.ML_ENABLED !== 'false';

const app = express();
app.use(cors({ origin: WEB_ORIGIN.split(','), credentials: false }));
app.use(express.json({ limit: '2mb' }));

// Serve the static frontend (so we only need ONE port for everything)
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'web')));

// ============================================================
//  Provider selection — chooses broker based on .env
//  Priority: BROKER=upstox → UpstoxProvider
//            BROKER=kotak  → KotakProvider
//            BROKER=breeze → BreezeProvider
//            Otherwise / missing creds → MockProvider
// ============================================================
function makeProvider() {
    const broker = (process.env.BROKER || '').toLowerCase();
    const wantMock = process.env.USE_MOCK === 'true';
    if (wantMock) return createBreezeOrMockProvider({ useMock: true });

    // PREFER Upstox if EITHER token exists — Extended (366-day) is sufficient
    // for all market data even if the daily token has expired.
    if ((process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_EXTENDED_TOKEN) && broker !== 'indianapi-only') {
        try {
            const p = new UpstoxProvider({
                accessToken: process.env.UPSTOX_ACCESS_TOKEN,
                extendedToken: process.env.UPSTOX_EXTENDED_TOKEN,
                apiKey: process.env.UPSTOX_API_KEY,
                apiSecret: process.env.UPSTOX_API_SECRET,
                redirectUri: process.env.UPSTOX_REDIRECT_URI
            });
            p.verifyToken()
                .then(() => console.log('[upstox] live session ready — PRIMARY provider'))
                .catch(e => console.error('[upstox] token verify failed:', e.message.slice(0, 80)));
            return p;
        } catch (e) {
            console.error('[provider] Upstox setup failed, falling back:', e.message);
        }
    }

    if (broker === 'indianapi' || (process.env.INDIANAPI_KEY && !process.env.UPSTOX_ACCESS_TOKEN)) {
        try {
            const p = new IndianApiProvider({ apiKey: process.env.INDIANAPI_KEY });
            console.log('[indianapi] hybrid provider ready (Yahoo for indices, indianapi for movers)');
            return p;
        } catch (e) {
            console.error('[provider] IndianAPI setup failed:', e.message);
        }
    }

    if (broker === 'upstox' || process.env.UPSTOX_ACCESS_TOKEN) {
        try {
            const p = new UpstoxProvider({
                accessToken: process.env.UPSTOX_ACCESS_TOKEN,
                extendedToken: process.env.UPSTOX_EXTENDED_TOKEN,
                apiKey: process.env.UPSTOX_API_KEY,
                apiSecret: process.env.UPSTOX_API_SECRET,
                redirectUri: process.env.UPSTOX_REDIRECT_URI
            });
            // Verify token in background — surfaces auth errors early
            p.verifyToken()
                .then(d => console.log('[upstox] live session ready'))
                .catch(e => console.error('[upstox] token verify failed:', e.message));
            return p;
        } catch (e) {
            console.error('[provider] Upstox setup failed — falling back to mock:', e.message);
            return createBreezeOrMockProvider({ useMock: true });
        }
    }

    if (broker === 'kotak' || process.env.KOTAK_ACCESS_TOKEN || process.env.KOTAK_CONSUMER_KEY) {
        try {
            const p = new KotakProvider({
                accessToken: process.env.KOTAK_ACCESS_TOKEN || process.env.KOTAK_CONSUMER_KEY,
                mobile: process.env.KOTAK_MOBILE,
                mpin: process.env.KOTAK_MPIN,
                totpSecret: process.env.KOTAK_TOTP_SECRET,
                ucc: process.env.KOTAK_UCC
            });
            // Per official Kotak Neo docs: even market data (quotes, scripmaster)
            // requires the baseUrl returned by MPIN validate. So full TOTP+MPIN
            // login is required. We kick it off in the background — quotes can
            // still be called and will block on login completing.
            p.login().then(() => console.log('[kotak] live session established'))
                     .catch(e => console.error('[kotak] login failed:', e.message));
            return p;
        } catch (e) {
            console.error('[provider] Kotak setup failed — falling back to mock:', e.message);
            return createBreezeOrMockProvider({ useMock: true });
        }
    }

    return createBreezeOrMockProvider({
        apiKey: process.env.BREEZE_API_KEY,
        apiSecret: process.env.BREEZE_API_SECRET,
        sessionToken: process.env.BREEZE_SESSION_TOKEN,
        useMock: process.env.USE_MOCK !== 'false'
    });
}
const provider = makeProvider();

// 1-click Upstox OAuth refresh — daily token via single browser click.
// Routes: /api/auth/upstox/{login,callback,status}
mountUpstoxOAuth(app, provider, () => `http://localhost:${PORT}`);

// Cache wraps provider.getHistorical → multi-TF and signal endpoints
// pull from RAM instead of round-tripping to Yahoo every time.
const candleCache = new CandleCache(provider);
candleCache.startRefresher();

// Weekly auto-retrain of the Path Forecaster (Sunday 03:00 IST)
startWeeklyScheduler();

// Latest multi-TF snapshot cached for the approval engine
let latestMtfSnapshot = { call: [], put: [] };

const engine = new SignalEngine();

// ML scorer — calls Python FastAPI service. Soft-fails so signals still work if ML offline.
async function mlScorer(featureVector) {
    if (!ML_ENABLED) return null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(ML_URL + '/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(featureVector),
            signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

const ivHistoryStore = {};
const recentTradesStore = [];

const engineV2 = new SignalEngineV2({
    confidenceThreshold: 35,  // opportunistic — fire on any valid setup
    cooldownSec: 30,  // opportunistic — short cooldown, fire when next valid setup appears
    mlScorer,
    ivHistory: ivHistoryStore,
    recentTrades: recentTradesStore
});

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

// ============================================================
//  IndianAPI-specific endpoints (top movers, stock detail)
//  Only available when the active provider supports them.
// ============================================================
app.get('/api/discovery/movers', async (req, res) => {
    try {
        if (typeof provider.getTopMovers !== 'function') {
            return res.json({ supported: false, reason: 'Active provider does not support discovery' });
        }
        const data = await provider.getTopMovers();
        res.json({ supported: true, ...data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/discovery/stock/:name', async (req, res) => {
    try {
        if (typeof provider.getStockDetail !== 'function') {
            return res.status(404).json({ error: 'Provider does not support stock detail' });
        }
        const data = await provider.getStockDetail(req.params.name);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
//  Weekly history endpoints — every trade of the current week
//  Resets at Monday 00:00 IST (old week auto-archived to data/archive/)
// ============================================================
app.get('/api/history/week', (req, res) => {
    res.json({
        summary: history.summary(),
        trades: history.list()
    });
});

app.post('/api/history/trade', (req, res) => {
    try {
        const t = history.addTrade(req.body);
        res.json({ ok: true, trade: t, summary: history.summary() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/history/batch', (req, res) => {
    try {
        const trades = Array.isArray(req.body) ? req.body : (req.body.trades || []);
        const added = history.addBatch(trades);
        res.json({ ok: true, added, summary: history.summary() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/history/week', (req, res) => {
    history.clear();
    res.json({ ok: true, summary: history.summary() });
});

// ============================================================
//  Multi-strategy confluence — pluggable framework
// ============================================================
// Local Node-based win-prob scorer (bootstrap model). Falls back gracefully if not trained.
async function localWinProbScorer(featureVector) {
    if (!winProbModel.isReady()) return null;
    return winProbModel.predict(featureVector);
}

app.post('/api/signals/confluence', async (req, res) => {
    try {
        const { symbol = 'NIFTY', candles, vix = 15, accountSize = 500000, riskPercent = 2 } = req.body;
        const eventGate = checkEventGate();
        let newsSentiment = null;
        try { await news.get(); newsSentiment = news.marketSentiment(); } catch (_) {}
        const scorer = winProbModel.isReady() ? localWinProbScorer : mlScorer;
        const result = await orchestrator.evaluate({
            candles, vix, eventGate, newsSentiment, mlScorer: scorer
        });

        // Enrich with strike + SL/TP/sizing when a signal fires
        let actionable = null;
        if (result.side !== 'NO_TRADE') {
            let chain = [];
            try { chain = await provider.getOptionChain(symbol); } catch (_) {}
            actionable = buildActionableSignal({
                verdict: result, candles, chain, symbol,
                accountSize, riskPercent
            });
        }

        // AI Path Forecast on fire — preview what the model thinks comes next
        let forecast = null;
        if (result.side !== 'NO_TRADE') {
            try { forecast = pathForecaster.forecast({ candles, side: result.side, tfMin: 5 }); }
            catch (e) {}
        }

        // V2 Approval Engine — find reasons NOT to take this trade
        let approval = null;
        if (result.side !== 'NO_TRADE' && actionable) {
            try {
                const regimeCls = classifyRegime({ candles, eventGate });
                let chainForApproval = [];
                try { chainForApproval = await provider.getOptionChain(symbol); } catch (_) {}
                approval = approveTrade({
                    side: result.side, candles,
                    chain: chainForApproval, option: actionable.option,
                    spotEntry: actionable.spot.entry,
                    stopLoss: actionable.spot.stopLoss,
                    target1: actionable.spot.target1,
                    target2: actionable.spot.target2,
                    firingStrategies: actionable.firingStrategies || [],
                    regime: regimeCls, eventGate, newsSentiment,
                    mtfData: latestMtfSnapshot, forecast
                });
                // Calibrate raw score
                const adj = calibrator.adjust(approval.finalScore);
                approval.calibratedScore = adj.adjusted;
                approval.calibration = adj;
                approval.regimeDetails = regimeCls;
            } catch (e) { console.error('[approval]', e); }
        }

        // Budget-aware multi-strike alternatives (always show 3-5 options)
        let strikeOptions = null;
        if (result.side !== 'NO_TRADE') {
            try {
                let scanChain = [];
                try { scanChain = await provider.getOptionChain(symbol); } catch (_) {}
                strikeOptions = scanStrikes({
                    symbol, side: result.side,
                    spot: candles[candles.length - 1].close,
                    candles, accountSize, riskPercent,
                    chain: scanChain, iv: 0.18
                });
            } catch (e) { console.error('[strike-scan]', e); }
        }

        // ──────────────────────────────────────────────────────────────
        // SCORE GATE — only surface high-confidence signals to the UI.
        // V2 rule: signal must clear the AI Approval threshold (default 70).
        // Below threshold → still returned, but flagged so the UI
        // renders it in Possibles, not as an actionable card.
        // Client can override via ?minScore=N query param.
        // ──────────────────────────────────────────────────────────────
        // God Mode default = 0 (no score gate). Pass ?minScore=X to raise floor.
        const minScore = Math.max(0, parseInt(req.query.minScore || req.body.minScore || 0, 10));
        // Substance gate (always on, even in God Mode): need at least ONE of —
        //   (a) approval.finalScore >= minScore (user threshold)
        //   (b) ≥ 2 firing strategies (multi-confirmation)
        //   (c) ≥ 1 strategy + AI Path Forecast verdict FAVORABLE
        const firingCount = result.votes?.filter(v => v.fired).length || 0;
        const fcFavorable = forecast?.verdict === 'FAVORABLE';
        const substance = (approval?.finalScore || 0) >= minScore
            || firingCount >= 2
            || (firingCount >= 1 && fcFavorable);
        const passesGate = !approval || substance;
        const suppressedReason = !passesGate
            ? `AI approval ${approval.finalScore} < ${minScore} threshold`
            : null;

        res.json({
            symbol, ...result,
            actionable: passesGate ? actionable : null,
            forecast, approval, strikeOptions,
            suppressed: !passesGate,
            suppressedReason,
            minScoreUsed: minScore,
            modelStatus: winProbModel.isReady() ? 'node-local' : 'unavailable'
        });
    } catch (e) {
        console.error('[confluence]', e);
        res.status(500).json({ error: e.message });
    }
});

// Online update from a closed trade — keeps the model learning
app.post('/api/signals/online-update', (req, res) => {
    try {
        const { featureVector, result } = req.body;
        if (!featureVector || !result) return res.status(400).json({ error: 'need featureVector + result' });
        winProbModel.onlineUpdate(featureVector, result);
        res.json({ ok: true, sampleCount: winProbModel.model?.sampleCount, lastUpdate: winProbModel.model?.lastOnlineUpdate });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/signals/model-status', (req, res) => {
    if (!winProbModel.isReady()) return res.json({ ready: false });
    res.json({
        ready: true,
        sampleCount: winProbModel.model.sampleCount,
        valAcc: winProbModel.model.valAcc,
        trainedAt: winProbModel.model.trainedAt,
        lastOnlineUpdate: winProbModel.model.lastOnlineUpdate || null,
        topFeatures: winProbModel.model.topFeatures
    });
});

// Record live trade outcome → feeds adaptive weights + future ML retrain
app.post('/api/signals/outcome', (req, res) => {
    try {
        const { strategyIds, result, trade } = req.body;
        if (Array.isArray(strategyIds) && (result === 'WIN' || result === 'LOSS')) {
            adaptiveWeights.recordOutcome(strategyIds, result);
        }
        // Persist the full trade for retraining later
        if (trade) {
            history.addTrade({ ...trade, source: trade.source || 'live' });
        }
        res.json({ ok: true, adaptive: adaptiveWeights.snapshot() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Live adaptive-weight inspection
app.get('/api/signals/adaptive-weights', (req, res) => {
    res.json(adaptiveWeights.snapshot());
});

app.get('/api/strategies', (req, res) => {
    res.json(orchestrator.strategies.map(s => ({
        id: s.id, name: s.name, marketBias: s.marketBias, weight: s.weight
    })));
});

// ============================================================
//  Event awareness
// ============================================================
app.get('/api/event-gate', (req, res) => {
    res.json({
        now: Date.now(),
        gate: checkEventGate(),
        next: nextEvent()
    });
});

// ============================================================
//  News pulse
// ============================================================
// ============================================================
//  Chart-overlay levels (S/R + OI walls)
// ============================================================
// ============================================================
//  Multi-timeframe signal scanner — runs orchestrator across all TFs in parallel
// ============================================================
app.get('/api/signals/multi-tf/:symbol', async (req, res) => {
    const symbol = req.params.symbol;
    const tfs = (req.query.tfs || '1minute,3minute,5minute,15minute,30minute,60minute,1day').split(',');
    try {
        const eventGate = checkEventGate();
        let newsSentiment = null;
        try { await news.get(); newsSentiment = news.marketSentiment(); } catch (_) {}
        const scorer = winProbModel.isReady() ? localWinProbScorer : mlScorer;
        const accountSize = parseFloat(req.query.accountSize) || 500000;
        const riskPercent = parseFloat(req.query.riskPercent) || 2;
        const vix = parseFloat(req.query.vix) || 15;

        const results = await Promise.all(tfs.map(async (tf) => {
            try {
                const candles = await candleCache.get(symbol, tf, 220);
                if (candles.length < 50) return { tf, side: 'NO_DATA', candleCount: candles.length };
                const verdict = await orchestrator.evaluate({
                    candles, vix, eventGate, newsSentiment, mlScorer: scorer
                });
                let actionable = null;
                let approvalScore = null;
                if (verdict.side !== 'NO_TRADE') {
                    let chain = [];
                    try { chain = await provider.getOptionChain(symbol); } catch (_) {}
                    actionable = buildActionableSignal({ verdict, candles, chain, symbol, accountSize, riskPercent });
                    // Apply AI approval gate per timeframe
                    try {
                        const regimeCls = classifyRegime({ candles, eventGate });
                        const fcMtfMap = { '1minute':1,'3minute':3,'5minute':5,'15minute':15,'30minute':30,'60minute':60,'1day':375 };
                        const tfFc = pathForecaster.forecast({ candles, side: verdict.side, tfMin: fcMtfMap[tf] || 5 });
                        const approval = approveTrade({
                            side: verdict.side, candles,
                            chain, option: actionable?.option,
                            spotEntry: actionable?.spot?.entry,
                            stopLoss: actionable?.spot?.stopLoss,
                            target1: actionable?.spot?.target1,
                            target2: actionable?.spot?.target2,
                            firingStrategies: actionable?.firingStrategies || [],
                            regime: regimeCls, eventGate, newsSentiment,
                            mtfData: latestMtfSnapshot, forecast: tfFc
                        });
                        approvalScore = approval.finalScore;
                        // Hide actionable below threshold (default 70)
                        // God Mode: no per-TF gate. UI shows confidence so user picks.
                        const tfMinScore = Math.max(0, parseInt(req.query.minScore || 0, 10));
                        if (approval.finalScore < tfMinScore) actionable = null;
                    } catch (e) {}
                }
                // Path Forecast — runs even on NO_TRADE so we can preview
                let forecast = null;
                if (verdict.side !== 'NO_TRADE') {
                    try {
                        const tfMinMap = { '1minute':1,'3minute':3,'5minute':5,'15minute':15,'30minute':30,'60minute':60,'1day':375 };
                        forecast = pathForecaster.forecast({
                            candles, side: verdict.side, tfMin: tfMinMap[tf] || 5
                        });
                    } catch (e) {}
                }
                // If approval gate suppressed the actionable, downgrade the
                // tile's "side" to NO_TRADE so the multi-TF strip doesn't
                // light up with a random signal indicator.
                const effectiveSide = actionable ? verdict.side : 'NO_TRADE';
                return {
                    tf,
                    side: effectiveSide,
                    rawSide: verdict.side,
                    confluenceScore: verdict.confluenceScore,
                    approvalScore,
                    callScore: verdict.callScore,
                    putScore: verdict.putScore,
                    tier: verdict.tier,
                    regime: verdict.regime?.regime,
                    firingCount: verdict.votes.filter(v => v.fired).length,
                    firingNames: verdict.votes.filter(v => v.fired).map(v => v.name),
                    topPossibles: verdict.possibles?.slice(0, 2) || [],
                    actionable,
                    forecast
                };
            } catch (e) {
                return { tf, error: e.message };
            }
        }));

        // Aggregate verdict — if 2+ TFs fire the same direction, it's high-conviction
        const firingTfs = results.filter(r => r.side === 'BUY_CALL' || r.side === 'BUY_PUT');
        const callTfs = firingTfs.filter(r => r.side === 'BUY_CALL').map(r => r.tf);
        const putTfs = firingTfs.filter(r => r.side === 'BUY_PUT').map(r => r.tf);
        // Cache for the approval engine
        latestMtfSnapshot = { call: callTfs, put: putTfs };
        let aggregate = 'NO_TRADE';
        if (callTfs.length >= 2) aggregate = 'BUY_CALL';
        else if (putTfs.length >= 2) aggregate = 'BUY_PUT';
        else if (callTfs.length === 1 && putTfs.length === 0) aggregate = 'WATCH_CALL';
        else if (putTfs.length === 1 && callTfs.length === 0) aggregate = 'WATCH_PUT';

        res.json({
            symbol,
            aggregate,
            firingTfs: { call: callTfs, put: putTfs },
            tfs: results
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
//  Active trade tracking + exit warnings
// ============================================================
app.post('/api/active-trade/enter', (req, res) => {
    try {
        const t = tracker.enter(req.body);
        res.json({ ok: true, active: t });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/active-trade/exit', (req, res) => {
    try {
        const exitPremium = Number(req.body?.exitPremium);
        const spotExit = Number(req.body?.spotExit);
        const closed = tracker.exit(req.body?.reason || 'manual');
        // Also log to history — FLATTEN nested option.* and sizing.* so the
        // history rows show strike / lots / pnl instead of "undefined".
        if (closed) {
            const entryPrem = closed.option?.premium ?? 0;
            const exitPrem = Number.isFinite(exitPremium) ? exitPremium : entryPrem;
            const lots = closed.sizing?.lots ?? 0;
            const qty = closed.sizing?.quantity ?? (lots * (closed.option?.lotSize || 0));
            const pnl = Math.round((exitPrem - entryPrem) * qty);
            const result = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT';
            history.addTrade({
                ...closed,
                strike: closed.option?.strike,
                right: closed.option?.right,
                entry: entryPrem,
                exit: exitPrem,
                stopLoss: closed.option?.premiumSL,
                target1: closed.option?.premiumT1,
                target2: closed.option?.premiumT2,
                lots,
                quantity: qty,
                pnl,
                costs: 0,
                result,
                exitReason: closed.exitReason || 'manual',
                spotEntry: closed.spot?.entry,
                spotExit: Number.isFinite(spotExit) ? spotExit : null,
                confidence: closed.confluenceScore,
                source: 'live'
            });
            // V2: feed outcome to confidence calibrator so it learns
            try {
                calibrator.record({
                    approvalScore: closed.approval?.finalScore || closed.confluenceScore,
                    grade: closed.approval?.grade || 'C',
                    regime: closed.approval?.regimeDetails?.regime || closed.regime?.regime,
                    strategyIds: (closed.firingStrategies || []).map(s => s.id),
                    pnl,
                    result
                });
            } catch (e) { console.error('[calibrator.record]', e); }
        }
        res.json({ ok: true, closed });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/active-trade/status', async (req, res) => {
    try {
        const { candles } = req.body;
        const active = tracker.getActive();
        if (!active) return res.json({ active: null });

        // AI Path Forecast — what does the model think will happen next?
        // We compute this FIRST because the exit evaluator uses it to
        // distinguish "drawdown that will recover" from "confirmed reversal".
        let forecast = null;
        try {
            forecast = pathForecaster.forecast({
                candles, side: active.side, tfMin: 5
            });
        } catch (e) { /* non-fatal */ }

        const monitor = tracker.evaluate({ candles, forecast });

        // Live Greeks recompute (Δ / Γ / Θ / V)
        let greeks = null;
        try {
            const spot = candles[candles.length - 1].close;
            const iv = (active.option.iv || 15) / 100;
            const T = Math.max(1 / (365 * 24), daysToExpiry(active.symbol) / 365);
            greeks = blackScholes({
                S: spot, K: active.option.strike, T, iv,
                right: active.option.right
            });
        } catch (e) {}

        // Gamma blast detector — fires when DTE→0 + ATM + accelerating
        let gammaBlast = null;
        try {
            const spot = candles[candles.length - 1].close;
            gammaBlast = detectGammaBlast({
                candles, symbol: active.symbol,
                strike: active.option.strike, right: active.option.right,
                iv: (active.option.iv || 15) / 100,
                spotNow: spot, side: active.side
            });
        } catch (e) {}

        // S/R levels for proximity guidance
        let srLevels = null;
        try { srLevels = computeSR(candles, { clusterPct: 0.0015 }); } catch (e) {}

        // Profit-taking playbook — concrete next-action rules
        let playbook = null;
        try {
            playbook = buildProfitPlaybook({
                trade: active, monitor, gamma: gammaBlast, srLevels, candles, forecast
            });
        } catch (e) {}

        // Live regime (so user sees if regime is flipping against them)
        let regime = null;
        try { regime = classifyRegime({ candles, eventGate: checkEventGate() }); } catch (e) {}

        res.json({ active, monitor, forecast, greeks, gammaBlast, srLevels: {
            support: srLevels?.support?.slice(0, 3) || [],
            resistance: srLevels?.resistance?.slice(0, 3) || []
        }, playbook, regime });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/active-trade/history', (req, res) => {
    res.json(tracker.getHistory());
});

// "Best Trades for My Budget" — scans ALL 4 indices, ranks CALL + PUT setups
// by AI forecast edge × budget fit. Used by the home screen Best Opportunities panel.
app.get('/api/best-trades', async (req, res) => {
    try {
        const accountSize = parseFloat(req.query.accountSize) || 500000;
        const riskPercent = parseFloat(req.query.riskPercent) || 2;
        const symbols = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'];
        const trades = [];

        for (const symbol of symbols) {
            try {
                // Use cached candles (server cache makes this near-instant)
                const candles = await candleCache.get(symbol, '5minute', 220);
                if (candles.length < 60) continue;
                const spot = candles[candles.length - 1].close;
                let chain = [];
                try { chain = await provider.getOptionChain(symbol); } catch (_) {}

                // Run scanner for BOTH sides
                for (const side of ['BUY_CALL', 'BUY_PUT']) {
                    const scan = scanStrikes({ symbol, side, spot, candles,
                        accountSize, riskPercent, chain, iv: 0.18 });
                    const best = scan.candidates.find(c => c.recommended) || scan.candidates[0];
                    if (!best) continue;

                    // AI Path Forecast for this side on this symbol
                    const forecast = pathForecaster.forecast({
                        candles, side, tfMin: 5
                    });

                    // Score: P(T1) × reward / capital - P(SL) × maxLoss / capital
                    const pT1 = (forecast?.pT1 || 50) / 100;
                    const pSL = (forecast?.pSL || 40) / 100;
                    const ev = pT1 * best.t1Reward - pSL * best.maxLossActual;
                    const evPerRupee = best.capitalRequired > 0 ? ev / best.capitalRequired : 0;
                    const verdictBoost = forecast?.verdict === 'FAVORABLE' ? 1.2 :
                                         forecast?.verdict === 'UNFAVORABLE' ? 0.4 : 1.0;
                    const finalScore = evPerRupee * 100 * verdictBoost;

                    trades.push({
                        symbol, side,
                        strike: best.strike, right: best.right,
                        premium: best.premium,
                        slPrem: best.slPrem, t1Prem: best.t1Prem, t2Prem: best.t2Prem,
                        lots: best.lots, quantity: best.quantity,
                        capitalRequired: best.capitalRequired,
                        maxLossActual: best.maxLossActual,
                        t1Reward: best.t1Reward, t2Reward: best.t2Reward,
                        rr: best.rr,
                        delta: best.delta, gamma: best.gamma, theta: best.theta,
                        spot, atm: scan.atmStrike, offset: best.label,
                        forecast: forecast ? {
                            pT1: forecast.pT1, pSL: forecast.pSL,
                            pTimeout: forecast.pTimeout,
                            verdict: forecast.verdict, confidence: forecast.confidence,
                            expectedMfePct: forecast.expectedMfePct,
                            expectedMaePct: forecast.expectedMaePct,
                            source: forecast.source
                        } : null,
                        score: parseFloat(finalScore.toFixed(2)),
                        fitsBudget: best.fitsBudget
                    });
                }
            } catch (e) { console.error('[best-trades]', symbol, e.message); }
        }

        // Rank: only keep fits-budget AND positive expected edge, sort by score
        const ranked = trades
            .filter(t => t.fitsBudget && t.forecast && t.forecast.pT1 > t.forecast.pSL)
            .sort((a, b) => b.score - a.score);

        res.json({
            budget: { accountSize, riskPercent, maxLossBudget: Math.round(accountSize * riskPercent / 100) },
            top: ranked.slice(0, 5),
            allConsidered: trades.length,
            evaluatedAt: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Budget-aware multi-strike scanner — best strikes that FIT YOUR MONEY
app.post('/api/strikes/scan', async (req, res) => {
    try {
        const { symbol = 'NIFTY', side, candles, accountSize = 500000, riskPercent = 2, iv = 0.18 } = req.body;
        if (!side || !candles || candles.length < 60) {
            return res.status(400).json({ error: 'need side + candles[60+]' });
        }
        const spot = candles[candles.length - 1].close;
        let chain = [];
        try { chain = await provider.getOptionChain(symbol); } catch (_) {}
        const result = scanStrikes({ symbol, side, spot, candles, accountSize, riskPercent, chain, iv });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// AI Path Forecast — standalone endpoint for the UI to query
app.post('/api/forecast', (req, res) => {
    try {
        const { candles, side, tfMin = 5 } = req.body;
        if (!candles || !side) return res.status(400).json({ error: 'need candles + side' });
        const out = pathForecaster.forecast({ candles, side, tfMin });
        res.json({ ok: true, forecast: out, ready: pathForecaster.isReady() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Cache stats — diagnose responsiveness
app.get('/api/cache/stats', (req, res) => {
    res.json(candleCache.stats());
});

// CPR (daily + weekly Central Pivot Range + Floor Pivots)
app.post('/api/cpr', (req, res) => {
    try {
        const { candles } = req.body;
        const cpr = computeAllCPR(candles);
        const spot = candles[candles.length - 1]?.close;
        const proximity = spot && cpr?.daily ? cprProximity(spot, cpr.daily) : null;
        res.json({ ...cpr, proximity, spot });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mid-candle pattern detector — predicts BEFORE candle closes
app.post('/api/patterns', (req, res) => {
    try {
        const { candles, tfMin = 5 } = req.body;
        if (!candles?.length) return res.status(400).json({ error: 'no candles' });
        const progress = estimateCandleProgress(candles[candles.length - 1], tfMin);
        const result = detectPatterns(candles, progress);
        res.json({ ...result, candleProgress: progress });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full-series pattern scan — returns markers for chart annotation
app.post('/api/patterns/scan', (req, res) => {
    try {
        const { candles, minConf = 55, lookbackBars = 250 } = req.body;
        if (!candles?.length) return res.status(400).json({ error: 'no candles' });
        const markers = scanAllCandles(candles, { minConf, lookbackBars });
        // Bias breakdown
        const bullish = markers.filter(m => m.bias === 'BULLISH').length;
        const bearish = markers.filter(m => m.bias === 'BEARISH').length;
        const neutral = markers.filter(m => m.bias === 'NEUTRAL').length;
        // Latest 5 patterns for the panel
        const latest5 = markers.slice(-5).reverse();
        res.json({ markers, count: markers.length, bullish, bearish, neutral, latest5 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Always-visible forecast preview — runs both CALL and PUT hypotheticals
app.post('/api/forecast/preview', (req, res) => {
    try {
        const { candles, tfMin = 5 } = req.body;
        if (!candles?.length) return res.status(400).json({ error: 'no candles' });
        const callFc = pathForecaster.forecast({ candles, side: 'BUY_CALL', tfMin });
        const putFc  = pathForecaster.forecast({ candles, side: 'BUY_PUT', tfMin });
        // Suggest which side has the better edge
        let suggestion = 'NEUTRAL';
        if (callFc && putFc) {
            const callEdge = callFc.pT1 - callFc.pSL;
            const putEdge = putFc.pT1 - putFc.pSL;
            if (callEdge > putEdge + 8) suggestion = 'CALL_BIAS';
            else if (putEdge > callEdge + 8) suggestion = 'PUT_BIAS';
        }
        res.json({ call: callFc, put: putFc, suggestion });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Market Regime — 8-class classifier (V2)
app.post('/api/regime', (req, res) => {
    try {
        const { candles } = req.body;
        const eventGate = checkEventGate();
        res.json(classifyRegime({ candles, eventGate }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Calibration summary (predicted vs realized winrate per bucket)
app.get('/api/calibration', (req, res) => {
    res.json(calibrator.summary());
});

// Manual trigger for path-forecaster retrain (for testing or post-data-update)
app.post('/api/retrain', async (req, res) => {
    try {
        const result = await runRetrain();
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/levels/sr/:symbol', async (req, res) => {
    try {
        const tfs = (req.query.tfs || '5minute,15minute,60minute,1day').split(',');
        const out = {};
        for (const tf of tfs) {
            try {
                const candles = await provider.getHistorical(req.params.symbol, tf, 200);
                if (candles.length < 30) { out[tf] = { supports: [], resistances: [] }; continue; }
                out[tf] = computeSR(candles, { lookback: 100, leftRight: 2, clusterPct: 0.0018, maxLevels: 3 });
            } catch (e) {
                out[tf] = { error: e.message };
            }
        }
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/levels/oi-walls/:symbol', async (req, res) => {
    try {
        const chain = await provider.getOptionChain(req.params.symbol, req.query.expiry);
        const q = await provider.getQuote(req.params.symbol);
        res.json(detectOIWalls(chain, { topN: 3, spot: q.ltp }));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/news/pulse', async (req, res) => {
    try {
        const items = await news.get();
        res.json({
            items,
            marketSentiment: news.marketSentiment(),
            updatedAt: news.lastFetch
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/discovery/52week', async (req, res) => {
    try {
        if (typeof provider.getFiftyTwoWeek !== 'function') {
            return res.status(404).json({ error: 'Provider does not support 52-week data' });
        }
        res.json(await provider.getFiftyTwoWeek());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/signal/evaluate', async (req, res) => {
    try {
        const { symbol, candles, currentPrice, chain, accountSize, riskPercent, engine: engineVersion } = req.body;
        // v2 is now default — v1 retained for comparison
        if (engineVersion === 'v1') {
            const signal = engine.evaluate({ symbol, candles, currentPrice, chain, accountSize, riskPercent });
            return res.json(signal);
        }
        // Track IV history per symbol for IV-percentile calc
        if (chain && chain.length) {
            const atmRows = chain.filter(o => Math.abs(o.strike - currentPrice) < 100);
            if (atmRows.length) {
                const atmIV = atmRows.reduce((a, b) => a + b.iv, 0) / atmRows.length;
                if (!ivHistoryStore[symbol]) ivHistoryStore[symbol] = [];
                ivHistoryStore[symbol].push(atmIV);
                if (ivHistoryStore[symbol].length > 60) ivHistoryStore[symbol].shift();
            }
        }
        const signal = await engineV2.evaluate({
            symbol, candles, currentPrice, chain,
            accountSize, riskPercent,
            ivHistory: ivHistoryStore
        });
        res.json(signal);
    } catch (e) {
        console.error('[signal/evaluate]', e);
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// Trade outcome reporting — feeds the risk adjuster + future ML retraining
app.post('/api/trade/record', (req, res) => {
    try {
        const { symbol, side, entry, exit, pnl, result, signalId, featureVector } = req.body;
        const trade = {
            symbol, side, entry, exit, pnl, result, signalId, featureVector,
            time: Date.now()
        };
        recentTradesStore.push(trade);
        if (recentTradesStore.length > 500) recentTradesStore.shift();
        res.json({ ok: true, totalTracked: recentTradesStore.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/trades/recent', (req, res) => {
    res.json(recentTradesStore.slice(-50));
});

app.get('/api/regime/:symbol', async (req, res) => {
    try {
        const candles = await provider.getHistorical(req.params.symbol, '5minute', 100);
        const { classifyRegime } = await import('./signal2.js');
        res.json(classifyRegime(candles));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/session', (req, res) => {
    import('./signal2.js').then(({ sessionPhase }) => {
        res.json(sessionPhase(Date.now()));
    });
});

// Backtest endpoint — runs synchronous backtest, returns metrics + trades
app.post('/api/backtest', async (req, res) => {
    try {
        const { runBacktest } = await import('./backtest.js');
        const { symbol = 'NIFTY', timeframe = '5minute', count = 500, accountSize = 500000, riskPercent = 2, confidenceThreshold = 60 } = req.body;
        const result = await runBacktest({
            provider, symbol, timeframe, count,
            accountSize, riskPercent, confidenceThreshold,
            mlScorer
        });
        // Truncate trades for response (keep last 100)
        res.json({
            metrics: result.metrics,
            equity: result.equity,
            trades: result.trades.slice(-100),
            totalTradesRecorded: result.trades.length
        });
    } catch (e) {
        console.error('[backtest]', e);
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// Retrain ML on backtest output
app.post('/api/ml/retrain-from-backtest', async (req, res) => {
    try {
        const { runBacktest, exportTrainingData } = await import('./backtest.js');
        const { symbol = 'NIFTY', count = 1000 } = req.body;
        const result = await runBacktest({
            provider, symbol, timeframe: '5minute', count,
            accountSize: 500000, riskPercent: 2, confidenceThreshold: 50
        });
        const trades = result.trades
            .filter(t => t.featureVector)
            .map(t => ({ featureVector: t.featureVector, result: t.result, pnl: t.pnl }));
        if (trades.length < 50) {
            return res.json({ ok: false, reason: `Only ${trades.length} trades — need 50+` });
        }
        const r = await fetch(ML_URL + '/retrain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(trades)
        });
        const out = await r.json();
        res.json({ ok: true, mlResponse: out, tradesSubmitted: trades.length });
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
                // SEND INITIAL SNAPSHOT — when market is closed, prices don't
                // change so the change-detector never emits. Without this the
                // UI shows "loading" forever on weekends/post-market.
                (async () => {
                    for (const sym of msg.symbols) {
                        try {
                            const q = await provider.getQuote(sym);
                            if (q?.ltp && ws.readyState === 1) {
                                ws.send(JSON.stringify({
                                    type: 'tick', symbol: sym,
                                    price: q.ltp, change: q.change,
                                    changePercent: q.changePercent,
                                    volume: q.volume, time: q.time,
                                    high: q.high, low: q.low, open: q.open
                                }));
                            }
                        } catch (e) {}
                    }
                })();
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
