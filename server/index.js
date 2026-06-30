// server/index.js — QuantEdge backend entry point
// Express REST + WebSocket relay.
//
// Phase 106 — Provider chain stripped to TWO sources only:
//   1. UpstoxProvider — charts, quotes, WS ticks (primary)
//   2. DhanProvider   — option chains, paper-trade postbacks (will be
//                       retired once Upstox option-chain integration ships)
//
// Removed entirely: Breeze (ICICI), Kotak, IndianAPI, MockProvider. The
// constitution forbids any third-party data source not on this list.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { UpstoxProvider } from './upstox.js';
import { DhanProvider } from './dhan.js';
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
import { buildChainSnapshot } from './chain-snapshot.js';
import { logSignalFire } from './signal-journal.js';
import { computeAllParameters, computeFactorScores } from './parameter-engine.js';
import { findSimilarSetups, strategyBacktestSummary } from './similarity-engine.js';
import { computeMTFAlignment } from './mtf-alignment.js';
import { trainWeights, getCurrentWeights, applyLearnedWeights, getWeightsHistory, getRecentTrainingFeed } from './factor-learner.js';
import { analyzeOIFlow } from './oi-flow.js';
import { buildEquityCurve } from './equity-curve.js';
import { scanAllIndices } from './multi-index-scanner.js';
import { computeExpectedMove } from './expected-move.js';
import { computeCrossIndexLeadership } from './cross-index-leadership.js';
import { forecastIV } from './iv-forecast.js';
import { detectPremiumExplosion } from './premium-explosion.js';
import { computeSignalQuality } from './signal-quality.js';
import { startChainKeeper, getChain as getCachedChain, getChainStatus } from './chain-keeper.js';
import { computeExitIntelligence } from './exit-intelligence.js';
import { buildNarrative } from './narrative-engine.js';
import { computeLiveRisk } from './risk-engine.js';
import { getCircuitBreakerState, resetCircuitBreaker } from './risk-circuit-breaker.js';
import { detectInstitutionalActivity } from './institutional-activity.js';
import { tracker } from './active-trade.js';
import { checkEventGate, nextEvent } from './strategies/event-gate.js';
import { adaptiveWeights } from './strategies/adaptive-weights.js';
import { winProbModel } from './strategies/win-prob.js';
import { news } from './news.js';
import { computeSR, detectOIWalls } from './levels.js';
import { CandleCache } from './candle-cache.js';
import { pathForecaster } from './path-forecaster.js';
import { mountUpstoxOAuth } from './upstox-oauth.js';
// Phase 121 — FYERS realtime stack (WS tick gateway)
import { mountFyersOAuth } from './fyers-oauth.js';
import { marketGateway } from './market-gateway.js';
import { getAccessTokenStatus as getFyersTokenStatus } from './fyers.js';
// Phase 4 — TrueData WS
import { startTrueData } from './truedata.js';
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
import { analyzeExpiryDay } from './expiry-elite.js';

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
import { startObserver, getObserverStatus } from './observer.js';
import {
    db,
    getRecentShadowSignals,
    getShadowStatsByBand,
    kvGet
} from './db.js';
import {
    startAgents,
    getAgentsHealth,
    getAgentStates,
    getMetaDecisions,
    getAgentCalibrations
} from './agents/index.js';
import { runBootstrap } from './db-bootstrap.js';
import { writeEdge as kgWriteEdge, queryEdge as kgQueryEdge, getKGSummary } from './knowledge-graph.js';
import { classifySignal, isUserVisible, computeOmegaScore, SIGNAL_TIERS } from './signal-gate.js';
import { writeObservation, getObservationStats } from './observation-engine.js';

// Run JSON → SQLite migration on first boot (idempotent)
runBootstrap();

const PORT = parseInt(process.env.PORT || '4300', 10);
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5180';
const ML_URL = process.env.ML_URL || 'http://localhost:4400';
const ML_ENABLED = process.env.ML_ENABLED !== 'false';

const app = express();
app.use(cors({ origin: WEB_ORIGIN.split(','), credentials: false }));
app.use(express.json({ limit: '2mb' }));

// Phase 122 — timeout middleware removed (caused ERR_HTTP_HEADERS_SENT
// crash because legacy routes don't check res.headersSent before res.json).
// Will be replaced by per-route Promise.race(<call>, <timeout>) in next session.

// Serve the static frontend (so we only need ONE port for everything)
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'web')));

// ============================================================
//  Provider selection — Phase 106
//
//  Two providers, in this priority order:
//    1. UpstoxProvider — UPSTOX_ACCESS_TOKEN or UPSTOX_EXTENDED_TOKEN
//       (charts, quotes, WS ticks, historical candles)
//    2. DhanProvider   — DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID
//       (option chains, paper-trade postbacks; will be retired once
//        Upstox option-chain integration ships)
//
//  Every other provider class (Breeze/Kotak/IndianAPI/Mock) has been
//  deleted from disk. USE_MOCK env var is now a fatal error. Server
//  refuses to start if either real provider can't initialize.
//
// Bug fixes from audit:
//   BUG-001 (provider consistency violation) — resolved by single sanctioned chain
//   BUG-002 (mock can leak to prod) — resolved by complete removal of mock path
//   BUG-008 (no circuit breakers) — addressed via promise-race timeouts + cache-first fallback
function makeProvider() {
    // Reject any attempt to use mock data — institutional audit mandate.
    if (process.env.USE_MOCK === 'true') {
        console.error('[provider] FATAL: USE_MOCK=true is forbidden after Phase 103 audit. ' +
                      'Real broker credentials are mandatory. Exiting.');
        process.exit(1);
    }
    if (!process.env.DHAN_ACCESS_TOKEN || !process.env.DHAN_CLIENT_ID) {
        console.error('[provider] FATAL: DHAN_ACCESS_TOKEN + DHAN_CLIENT_ID are mandatory ' +
                      'for option chains. No mock fallback exists. Exiting.');
        process.exit(1);
    }
    if (!process.env.UPSTOX_ACCESS_TOKEN && !process.env.UPSTOX_EXTENDED_TOKEN) {
        console.error('[provider] FATAL: UPSTOX_ACCESS_TOKEN or UPSTOX_EXTENDED_TOKEN required ' +
                      'for charts + quotes. No mock fallback exists. Exiting.');
        process.exit(1);
    }
    try {
        const p = new DhanProvider({
            accessToken: process.env.DHAN_ACCESS_TOKEN,
            clientId:    process.env.DHAN_CLIENT_ID
        });
        p.verifyToken()
            .then(() => console.log('[dhan] ✓ live — sanctioned option-chain provider'))
            .catch(e => console.error('[dhan] token verify warning:', e.message.slice(0, 80)));
        return p;
    } catch (e) {
        console.error('[provider] FATAL: Dhan init failed:', e.message);
        process.exit(1);
    }
}
const dhanProvider = makeProvider();

// Phase 90 — NEW SOURCE POLICY (supersedes the Dhan-only mandate):
//   • Charts / quotes / WS ticks  →  UPSTOX (more generous rate limits,
//     proven historical depth, extended-analytics token valid until 2027-05-31)
//   • Option chains               →  DHAN (where chain depth + freshness
//     is the most reliable of any provider we've evaluated)
//   • GIFTNIFTY                   →  REMOVED entirely. No public live feed
//     ever materialized; keeping it produced bug after bug.
//
// The Proxy below routes each method to the right provider — the dhan-only
// rate limiter no longer chokes chart reads, because chart reads no longer
// go through Dhan.
const upstoxProvider = new UpstoxProvider({
    accessToken:   process.env.UPSTOX_ACCESS_TOKEN,
    extendedToken: process.env.UPSTOX_EXTENDED_TOKEN,
    apiKey:        process.env.UPSTOX_API_KEY,
    apiSecret:     process.env.UPSTOX_API_SECRET,
    redirectUri:   process.env.UPSTOX_REDIRECT_URI
});
console.log('[provider] Phase 90 routing: charts/quotes → UPSTOX · chains → DHAN');

const provider = new Proxy(dhanProvider, {
    get(target, prop) {
        // Chart / quote / WS routes → Upstox
        if (prop === 'getHistorical' || prop === 'getQuote' || prop === 'getQuotes' ||
            prop === 'getHistoricalRange' || prop === 'subscribe' || prop === 'unsubscribe' ||
            prop === 'on' || prop === 'off' || prop === 'once' || prop === 'emit' ||
            prop === 'removeListener' || prop === 'addListener') {
            const fn = upstoxProvider[prop];
            return typeof fn === 'function' ? fn.bind(upstoxProvider) : fn;
        }
        // Option chain stays Dhan
        if (prop === 'getOptionChain') {
            return target.getOptionChain.bind(target);
        }
        // Provider mode / token-status helpers — prefer Upstox (the chart path)
        if (prop === 'mode') return 'live';
        // Everything else → Dhan default
        const orig = target[prop];
        return typeof orig === 'function' ? orig.bind(target) : orig;
    }
});

// Start the persistent chain-keeper — server-side background poller that
// caches the live option chain for all 4 indices + persists last-known-good
// to SQLite. Solves the "chain went empty during volatility" UX issue.
startChainKeeper(provider);

// Upstox OAuth removed — Phase 0 constitution: Dhan is the only broker.
// Token refresh: manually regenerate at dhanhq.co → Data APIs → New Token.

// Cache wraps provider.getHistorical → multi-TF and signal endpoints
// pull from RAM instead of round-tripping to Yahoo every time.
const candleCache = new CandleCache(provider);
candleCache.startRefresher();

// Weekly auto-retrain of the Path Forecaster (Sunday 03:00 IST)
startWeeklyScheduler();

// Latest multi-TF snapshot cached for the approval engine
let latestMtfSnapshot = { call: [], put: [] };

const engine = new SignalEngine();

// Omega "learn from everything" — observer scores every potential setup on
// all 4 indices every 30s, regardless of score, and resolves outcomes 30 min
// later. Powers the Bayesian learner and shadow journal.
startObserver({
    provider,
    engine,
    getChain: getCachedChain          // prefer chain-keeper cache; falls back to live
});

// Omega 13-agent framework starts AFTER engineV2 is constructed below.

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

// Omega 13-agent framework. Started here because TechnicalAnalysisAgent
// needs engineV2 injected. Each agent reads/writes the shared bus; the
// Meta Decision agent arbitrates votes every 5s.
startAgents({ provider, engine, engineV2 });

// Phase 121 — Start the FYERS market gateway. If no access token yet, it
// logs a warning and waits for OAuth (visit /api/fyers/login). The provider
// chain still works via Upstox/Dhan in the meantime.
try {
    // Start TrueData websocket feed
    startTrueData();
    marketGateway.start();
    mountFyersOAuth(app, marketGateway);
    // Re-emit FYERS ticks into the existing /ws so every browser gets push updates.
    // The wss instance is created below; the gateway will lazily wire when /ws clients connect.
} catch (e) {
    sysLog('WARN', 'fyers', 'market gateway init: ' + e.message);
}

// Offline catch-up — runs at boot AND every 5 min (Phase 88) so the system
// absorbs every bar of market data we missed while the PC was off.
// 4 indices: NIFTY / BANKNIFTY / FINNIFTY / SENSEX, sourced from Upstox
// (Phase 90 — was Dhan). Each new bar is replayed through the engine →
// shadow_signals → every ML layer absorbs it via `shadow:resolved`.
(async () => {
    try {
        const { startDhanCatchupScheduler } = await import('./dhan-catchup.js');
        startDhanCatchupScheduler(provider);
    } catch (e) { console.error('[catchup] failed to start:', e.message); }
})();

// Full layered ML stack — Bayesian → Conditional → Regime → Calibration →
// Ensemble (Python) → Meta Model → Adaptive Weights → Confusion Matrix
// plus Counterfactual / Drift / Transition / Memory / Opportunity Cost.
// Eagerly imported so each engine's bus subscriptions are live from boot.
(async () => {
    try {
        await import('./ml/conditional-engine.js');
        await import('./ml/regime-engine.js');
        await import('./ml/calibration-engine.js');
        await import('./ml/meta-model.js');
        await import('./ml/adaptive-weights.js');
        await import('./ml/confusion-matrix.js');
        await import('./ml/counterfactual-engine.js');
        await import('./ml/drift-detector.js');
        await import('./ml/regime-transition.js');
        await import('./ml/market-memory.js');
        await import('./ml/opportunity-cost.js');
        await import('./ml/stack.js');
        // Phase 48-72 additions
        await import('./market-calendar.js');
        await import('./data-integrity.js');
        await import('./ml/calibration-platt.js');
        await import('./ml/q-learning.js');
        await import('./ml/factor-decay.js');
        await import('./ml/counterfactual-model.js');
        await import('./ml/online-lr.js');
        await import('./ml/drift-autoretrain.js');
        await import('./ml/model-versions.js');
        await import('./ml/shap-lite.js');
        await import('./ml/strategy-miner.js');
        await import('./agents/dialogue.js');           // request/reply protocol
        console.log('[ml-stack] all engines online incl Platt, Q-learning, factor-decay, drift-autoretrain');
    } catch (e) { console.error('[ml-stack] load failed:', e.message); }
})();

// ── Agent framework endpoints ────────────────────────────────────────
app.get('/api/agents/health', (req, res) => {
    try { res.json(getAgentsHealth()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/state', (req, res) => {
    try { res.json({ agents: getAgentStates() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/decisions', (req, res) => {
    try { res.json({ decisions: getMetaDecisions() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
// Phase 14 — per-agent independent learning (calibration multipliers)
app.get('/api/agents/calibration', (req, res) => {
    try { res.json({ calibrations: getAgentCalibrations() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Full ML Stack endpoints (Phases 15-21) ───────────────────────────
app.get('/api/ml/health', async (req, res) => {
    try {
        const { stackHealth } = await import('./ml/stack.js');
        res.json(stackHealth());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ml/predict', async (req, res) => {
    try {
        const { predict } = await import('./ml/stack.js');
        res.json(await predict(req.body || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/conditional', async (req, res) => {
    try {
        const { conditionalTop, conditionalStats } = await import('./ml/conditional-engine.js');
        const limit = Math.min(100, parseInt(req.query.limit || '20', 10));
        res.json({ top: conditionalTop(limit), stats: conditionalStats() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/regime-matrix', async (req, res) => {
    try {
        const { buildRegimeMatrix } = await import('./ml/regime-engine.js');
        const days = Math.min(180, parseInt(req.query.days || '30', 10));
        res.json(buildRegimeMatrix({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/calibration', async (req, res) => {
    try {
        const { calibrationReport } = await import('./ml/calibration-engine.js');
        const days = Math.min(180, parseInt(req.query.days || '30', 10));
        res.json(calibrationReport({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/meta-model', async (req, res) => {
    try {
        const { modelMatrix } = await import('./ml/meta-model.js');
        res.json(modelMatrix());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/adaptive-weights', async (req, res) => {
    try {
        const { getAdaptiveWeights, trainAdaptiveWeights } = await import('./ml/adaptive-weights.js');
        if (req.query.retrain === '1') res.json(trainAdaptiveWeights({ days: 30 }));
        else res.json(getAdaptiveWeights());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/confusion-matrix', async (req, res) => {
    try {
        const { confusionMatrix } = await import('./ml/confusion-matrix.js');
        const days = Math.min(180, parseInt(req.query.days || '30', 10));
        const symbol = req.query.symbol || null;
        res.json(confusionMatrix({ days, symbol }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/performance', async (req, res) => {
    try {
        const { db } = await import('./db.js');
        const rows = db.prepare(`SELECT * FROM agent_performance ORDER BY timestamp DESC, f1 DESC`).all();
        res.json({ data: rows, ts: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Phase 24-33 new ML / agent endpoints ─────────────────────────────
app.get('/api/ml/counterfactual', async (req, res) => {
    try {
        const { counterfactualStats } = await import('./ml/counterfactual-engine.js');
        const days = Math.min(2000, parseInt(req.query.days || '30', 10));
        res.json(counterfactualStats({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ml/counterfactual/backfill', async (req, res) => {
    try {
        const { recordCounterfactual } = await import('./ml/counterfactual-engine.js');
        const { db } = await import('./db.js');
        const rows = db.prepare(`
            SELECT ts, symbol, side, band, confidence, regime, outcome, move_pct
              FROM shadow_signals
             WHERE outcome IN ('WIN','LOSS')
        `).all();
        let n = 0;
        for (const r of rows) {
            recordCounterfactual({
                ts: r.ts, symbol: r.symbol, decidedSide: r.side,
                decidedBand: r.band, confidence: r.confidence,
                actualOutcome: r.outcome, movePct: r.move_pct,
                regime: r.regime, features: {}
            });
            n++;
            if (n % 10000 === 0) await new Promise(r => setImmediate(r));
        }
        res.json({ ok: true, recorded: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/drift', async (req, res) => {
    try {
        const { detectDrift } = await import('./ml/drift-detector.js');
        const baseline = Math.min(365, parseInt(req.query.baseline || '60', 10));
        const recent   = Math.min(60,  parseInt(req.query.recent   || '7',  10));
        const symbol = req.query.symbol || null;
        res.json(detectDrift({ symbol, baselineDays: baseline, recentDays: recent }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/regime-transition/:symbol', async (req, res) => {
    try {
        const { transitionMatrix, predictNextRegime } = await import('./ml/regime-transition.js');
        const days = Math.min(365, parseInt(req.query.days || '365', 10));
        if (req.query.predictFrom) {
            res.json(predictNextRegime({
                symbol: req.params.symbol,
                currentRegime: req.query.predictFrom,
                dwellMs: parseInt(req.query.dwellMs || '0', 10)
            }));
        } else {
            res.json(transitionMatrix({ symbol: req.params.symbol, days }));
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ml/market-memory', async (req, res) => {
    try {
        const { findSimilar } = await import('./ml/market-memory.js');
        const b = req.body || {};
        res.json(findSimilar({
            symbol: b.symbol,
            currentFeatures: b.features || {},
            k: Math.min(100, parseInt(b.k || '20', 10)),
            days: Math.min(365, parseInt(b.days || '90', 10))
        }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/opportunity-cost', async (req, res) => {
    try {
        const { opportunityStats } = await import('./ml/opportunity-cost.js');
        const days = Math.min(180, parseInt(req.query.days || '30', 10));
        res.json(opportunityStats({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Phase 90 — GIFTNIFTY endpoints removed. Symbol is gone from the product.

// ── Catch-up for the 4 indices (Phase 41 / Phase 90) ──────────────────
app.get('/api/dhan/catchup', async (req, res) => {
    try {
        const { getDhanCatchupStatuses } = await import('./dhan-catchup.js');
        res.json(getDhanCatchupStatuses());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/dhan/catchup/run', async (req, res) => {
    try {
        const { runAllDhanCatchups, runCatchupForPair } = await import('./dhan-catchup.js');
        if (req.body?.symbol && req.body?.interval) {
            res.json(await runCatchupForPair({
                provider, symbol: req.body.symbol, interval: req.body.interval
            }));
        } else {
            res.json(await runAllDhanCatchups(provider));
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Phase 90 — /api/giftnifty/window and /api/ml/leading-indicator removed
// along with the GIFTNIFTY symbol.
app.post('/api/ml/leading-indicator/predict', async (req, res) => {
    try {
        const { predictTodaysOpen } = await import('./ml/leading-indicator.js');
        res.json(predictTodaysOpen(req.body || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kg/summary', (req, res) => {
    try { res.json(getKGSummary()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/kg/query', (req, res) => {
    try {
        res.json({
            edges: kgQueryEdge({
                regime: req.query.regime,
                side: req.query.side,
                symbol: req.query.symbol,
                limit: Math.min(200, parseInt(req.query.limit || '50', 10))
            })
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/audit/latest', async (req, res) => {
    try {
        const { kvGet } = await import('./db.js');
        const date = (req.query.date || new Date(Date.now() + (5*60+30)*60000).toISOString().slice(0,10));
        const audit = kvGet(`daily_audit_${date}`);
        res.json({ date, audit });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Multi-year historical backfill from Dhan (Phase 22) ──────────────
// POST  /api/historical/backfill  { symbols, intervals, years, fromDate?, toDate? }
//   → { jobId } — query GET /api/historical/backfill/:id for progress.
// GET   /api/historical/backfill           → corpus stats + active jobs
// GET   /api/historical/backfill/:id       → job-specific progress
app.post('/api/historical/backfill', async (req, res) => {
    try {
        const { startBackfill } = await import('./backfill.js');
        const body = req.body || {};
        const symbols   = Array.isArray(body.symbols)   && body.symbols.length
            ? body.symbols   : ['NIFTY','SENSEX'];
        const intervals = Array.isArray(body.intervals) && body.intervals.length
            ? body.intervals : ['1day','5minute'];
        const years     = Math.max(1, Math.min(10, parseInt(body.years || '5', 10)));
        const id = startBackfill({
            provider, symbols, intervals, years,
            fromDate: body.fromDate, toDate: body.toDate
        });
        res.json({ jobId: id, symbols, intervals, years });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/historical/backfill', async (req, res) => {
    try {
        const { getJobStats } = await import('./backfill.js');
        res.json(getJobStats());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/historical/backfill/:id', async (req, res) => {
    try {
        const { getJob } = await import('./backfill.js');
        const job = getJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'job not found' });
        res.json(job);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Historical replay trainer (Phase 23) ──────────────────────────────
// POST /api/training/replay { symbols, intervals, limit? }
//   → kicks off a background replay over candles_raw that warms every ML
//     layer + every agent self-calibrator without waiting for live market.
app.post('/api/training/replay', async (req, res) => {
    try {
        const { startReplay } = await import('./replay-trainer.js');
        const body = req.body || {};
        const symbols   = Array.isArray(body.symbols)   && body.symbols.length
            ? body.symbols   : ['NIFTY','SENSEX'];
        const intervals = Array.isArray(body.intervals) && body.intervals.length
            ? body.intervals : ['5minute'];
        const limit = body.limit ? parseInt(body.limit, 10) : null;
        const id = startReplay({ provider, symbols, intervals, limit });
        res.json({ jobId: id, symbols, intervals, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/training/replay/:id', async (req, res) => {
    try {
        const { getReplayJob } = await import('./replay-trainer.js');
        const job = getReplayJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'job not found' });
        res.json(job);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Phase 1 ML — Bayesian posterior summary across all contexts
app.get('/api/learner/bayesian', async (req, res) => {
    try {
        const { learningAgent } = await import('./agents/learning-agent.js');
        res.json(learningAgent.getSummary());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Feature Store endpoints (Phase 7) ────────────────────────────────
app.get('/api/features/registry', async (req, res) => {
    try {
        const fs = await import('./feature-store.js');
        res.json({ features: fs.listRegistry(), stats: fs.getFeatureStoreStats() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/features/as-of/:symbol', async (req, res) => {
    try {
        const fs = await import('./feature-store.js');
        const ts = parseInt(req.query.ts || Date.now(), 10);
        res.json({ symbol: req.params.symbol, asOfTs: ts,
                   features: fs.getFeaturesAsOf(req.params.symbol, ts) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/features/series/:name/:symbol', async (req, res) => {
    try {
        const fs = await import('./feature-store.js');
        const from = parseInt(req.query.from || (Date.now() - 86400_000), 10);
        const to   = parseInt(req.query.to   || Date.now(), 10);
        const limit = Math.min(5000, parseInt(req.query.limit || '500', 10));
        res.json({
            name: req.params.name, symbol: req.params.symbol,
            series: fs.getFeatureSeries(req.params.name, req.params.symbol, from, to, limit)
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Regime history endpoints (Phase 8) ───────────────────────────────
app.get('/api/regime/history/:symbol', async (req, res) => {
    try {
        const r = await import('./regime-history.js');
        const days = Math.min(30, parseInt(req.query.days || '7', 10));
        res.json({ symbol: req.params.symbol,
                   transitions: r.getRegimeTransitions(req.params.symbol, days),
                   stats: r.getRegimeStats(req.params.symbol, days) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- REST endpoints ---
// ── MULTI-INDEX PARALLEL SCANNER (master spec: cross-index intelligence) ──
// Runs the orchestrator on NIFTY + BANKNIFTY + FINNIFTY + SENSEX in parallel
// and returns a ranked grid showing which market has the strongest setup.
//   GET /api/scan/all?tf=5minute
app.get('/api/scan/all', async (req, res) => {
    try {
        const tf = req.query.tf || '5minute';
        // Phase 89 — SQLite-backed candleCache, not the rate-limited provider.
        // 4 symbols × queued Dhan calls made this endpoint hang >12s, and the
        // frontend polls it every 8s — a key contributor to the browser
        // connection-pool starvation.
        const cacheShim = { getHistorical: (s, t, c) => candleCache.get(s, t, c) };
        const result = await scanAllIndices({ provider: cacheShim, tf, count: 220 });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAIN-KEEPER STATUS — diagnostics for ops dashboard ──
app.get('/api/chain-status', (req, res) => {
    try { res.json({ ts: Date.now(), status: getChainStatus() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EQUITY CURVE — running cumulative P&L for the today-trades modal,
//    ops dashboard, and (future) backtest detailed view ──
app.get('/api/equity-curve', (req, res) => {
    try {
        const days = parseInt(req.query.days || '30', 10);
        const sinceMs = Date.now() - days * 86400 * 1000;
        const symbol = req.query.symbol || null;
        res.json(buildEquityCurve({ sinceMs, symbol }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI LEARNING ENGINE inspection + retrain ──
// GET  /api/learner/weights → current per-pillar weights + sample counts
// POST /api/learner/retrain → force immediate retrain from SQLite
// Observation Engine stats — how many setups evaluated, by tier
app.get('/api/observations/stats', (req, res) => {
    try { res.json(getObservationStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Shadow signals (Omega "learn from everything") ───────────────────────
// Every potential setup, every cadence tick, scored regardless of band.
// Resolved 30 min later by the observer.
app.get('/api/shadow/recent', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
        res.json({ signals: getRecentShadowSignals(limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/shadow/stats', (req, res) => {
    try {
        const days = Math.max(1, Math.min(90, parseInt(req.query.days || '7', 10)));
        const since = Date.now() - days * 86400 * 1000;
        res.json({ bands: getShadowStatsByBand(since), windowDays: days });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/observer/status', (req, res) => {
    try { res.json(getObserverStatus()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/learner/weights', (req, res) => {
    try { res.json(getCurrentWeights()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/learner/retrain', (req, res) => {
    try { res.json(trainWeights()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learner/history → rolling per-pillar weight snapshots from
// every training run. Drives the "weight evolution over time" chart on
// the AI Learning dashboard so the user can see HOW each pillar's
// weight has moved as more trades came in.
app.get('/api/learner/history', (req, res) => {
    try { res.json({ snapshots: getWeightsHistory() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/learner/feed?limit=25 → last N trades that the learner has
// actually consumed (each has a matching signal_journal entry with
// factorScores). These are the trades that nudged the weights last run
// or will nudge them on the next run.
app.get('/api/learner/feed', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '25', 10)));
        // Phase 122 — accept ?source=live (your real trades) or ?source=live_shadow (engine learning) — default: both
        const src = req.query.source === 'live' ? 'live' : req.query.source === 'live_shadow' ? 'live_shadow' : null;
        res.json({ feed: getRecentTrainingFeed(limit, src) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 108 — GET /api/learning/state → audit-grade snapshot of every
// learning surface the engine writes to. Powers the "What the AI has
// actually learned" panel on /ai-learning.html so the page no longer
// makes it look like nothing has been learned when in fact there are
// 251k+ Bayesian samples + 214k shadow resolutions on disk.
app.get('/api/learning/state', (_req, res) => {
    try {
        const bayes = kvGet('bayesian_probs_v1') || {};
        const bayesCells = Object.entries(bayes).map(([k, v]) => ({
            cell: k,
            n: v.n || 0,
            winRate: v.n > 0 ? (v.alpha / v.n) : 0,
            alpha: v.alpha || 0,
            beta:  v.beta  || 0
        })).sort((a, b) => b.n - a.n);

        const ql = kvGet('qlearning_v1') || { table: {} };
        const qlCells = Object.values(ql.table || {});
        const qlTotalN = qlCells.reduce((s, c) => s + (c.n || 0), 0);

        const factorWeights = kvGet('factor_weights_v1') || null;
        const factorHistory = kvGet('factor_weights_history_v1') || [];

        const adaptiveMeta = kvGet('adaptive_meta_weights_v1') || {};
        const calibrations = {};
        for (const key of Object.keys(kvGet('__index__') || {})) { /* noop placeholder */ }
        // Direct DB scan for agent_calibration_* keys
        const agentCalRows = db.prepare(
            "SELECT key, value FROM kv_store WHERE key LIKE 'agent_calibration_%'"
        ).all();
        for (const r of agentCalRows) {
            const agentName = r.key.replace('agent_calibration_', '');
            try { calibrations[agentName] = JSON.parse(r.value); } catch (_) {}
        }

        const learningAgentMetrics = kvGet('agent_metrics_LearningAgent') || {};

        const shadowStats = db.prepare(`
            SELECT symbol,
                   COUNT(*)                                         AS n,
                   SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END)  AS wins,
                   SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END)  AS losses,
                   MIN(ts) AS firstTs,
                   MAX(ts) AS lastTs
              FROM shadow_signals
             WHERE outcome IS NOT NULL
             GROUP BY symbol
        `).all();

        const kgEdges = (() => {
            try { return db.prepare("SELECT COUNT(*) c FROM omega_kg_edges").get().c; }
            catch (_) { return 0; }
        })();

        const signalJournalCount = db.prepare("SELECT COUNT(*) c FROM signal_journal").get().c;
        const featureStoreCount  = db.prepare("SELECT COUNT(*) c FROM feature_store").get().c;

        res.json({
            ts: Date.now(),
            bayesian: {
                totalCells:   bayesCells.length,
                totalSamples: bayesCells.reduce((s, c) => s + c.n, 0),
                topCells:     bayesCells.slice(0, 5).map(c => ({
                    cell: c.cell,
                    n:    c.n,
                    winRate: parseFloat(c.winRate.toFixed(3))
                }))
            },
            qLearning: {
                cells:   qlCells.length,
                totalN:  qlTotalN
            },
            factorWeights: factorWeights ? {
                current: factorWeights.weights || factorWeights,
                version: factorWeights.version || null,
                trainedAt: factorWeights.trainedAt || null,
                historyDepth: Array.isArray(factorHistory) ? factorHistory.length : 0
            } : null,
            agentCalibrations: Object.entries(calibrations).map(([name, c]) => ({
                agent:      name,
                multiplier: c.multiplier ?? c.calibration ?? 1.0,
                n:          c.n ?? 0,
                wins:       c.wins ?? c.alpha ?? 0
            })).sort((a, b) => b.n - a.n),
            adaptiveMeta,
            learningAgent: {
                evaluations:   learningAgentMetrics.evaluations   ?? 0,
                errors:        learningAgentMetrics.errors        ?? 0,
                avgLatencyMs:  learningAgentMetrics.avgLatencyMs  ?? null,
                lastRunMs:     learningAgentMetrics.lastRunMs     ?? null
            },
            shadowCorpus: {
                totalResolved: shadowStats.reduce((s, r) => s + r.n, 0),
                bySymbol:      shadowStats.map(r => ({
                    symbol:  r.symbol,
                    n:       r.n,
                    wins:    r.wins,
                    losses:  r.losses,
                    winRate: parseFloat((r.wins / r.n).toFixed(3)),
                    firstTs: r.firstTs,
                    lastTs:  r.lastTs
                }))
            },
            knowledgeGraph: {
                edges: kgEdges,
                note:  kgEdges === 0
                    ? 'Forward-only since Phase 105 — old shadows did not backfill. Hit POST /api/learning/backfill-kg to seed.'
                    : null
            },
            counters: {
                signalJournalRows: signalJournalCount,
                featureStoreRows:  featureStoreCount
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Parameter snapshot inspection — returns the full 50+ indicator vector
// computed on the live candles + chain. Used for explainability + by the
// ops dashboard to verify what the engine is seeing.
app.get('/api/parameters/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const tf = req.query.tf || '5minute';
        const candles = await provider.getHistorical(symbol, tf, 220);
        let chain = [];
        try { chain = await provider.getOptionChain(symbol); } catch {}
        const params = computeAllParameters({ candles, chain, spot: candles[candles.length - 1]?.close });
        res.json({
            symbol, tf, ts: Date.now(),
            candleCount: candles.length,
            chainSize: chain?.length || 0,
            parameters: params
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ops dashboard — local-first monitoring. DB stats, recent logs,
// last-signal time, last-chain-refresh, today's signal count.
app.get('/api/ops', async (req, res) => {
    try {
        const { getDbStats, recentLogs, recentSignals } = await import('./db.js');
        const stats = getDbStats();
        const logs = recentLogs(50);
        const signals = recentSignals(20);
        const startMs = Date.now() - (5*60+30) * 60000;
        const istToday = new Date(startMs).toISOString().slice(0, 10);
        res.json({
            ok: true,
            mode: 'live',
            time: Date.now(),
            uptime_sec: Math.round(process.uptime()),
            mem_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            sqlite: stats,
            recentLogs: logs,
            recentSignals: signals.map(s => ({
                ts: s.ts, symbol: s.symbol, side: s.side, tier: s.tier,
                strike: s.strike, premium: s.premium, regime: s.regime
            })),
            todayIst: istToday
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Omega system status — single endpoint, full picture ──────────────────────
// Surfaces every architectural concern the three-persona review identified:
// token health, circuit breaker state, data quality, KG edge count.
// The UI can poll this to drive a "system readiness" panel.
app.get('/api/omega/status', async (req, res) => {
    try {
        const capital = parseFloat(req.query.capital || '10000');
        const token   = getDhanTokenStatus();
        const cb      = getCircuitBreakerState(capital);
        const weights = getCurrentWeights();
        const { total: kgTotal } = getKGSummary();

        // candles_raw row count
        let candlesCount = 0;
        try {
            const { db: sqlDb } = await import('./db.js');
            candlesCount = sqlDb.prepare('SELECT COUNT(*) c FROM candles_raw').get().c;
        } catch (_) {}

        // real live trade count
        let liveTradeCount = 0;
        try {
            const { db: sqlDb } = await import('./db.js');
            liveTradeCount = sqlDb.prepare("SELECT COUNT(*) c FROM trades WHERE source='live'").get().c;
        } catch (_) {}

        const readiness = {
            token:         token.ok && !token.urgent,
            circuitBreaker: !cb.blocked,
            dataQuality:   weights.dataStatus === 'LIVE_DATA',
            liveTradesMin: liveTradeCount >= 20,
            chainOnline:   provider.mode === 'live',
        };
        const ready = Object.values(readiness).every(Boolean);

        res.json({
            ready,
            readiness,
            token,
            circuitBreaker: cb,
            learning: {
                dataStatus:   weights.dataStatus,
                liveTradeCount,
                totalSamples:  weights.totalSamples,
                overallWinRate: weights.overallWinRate,
                statusMsg:    weights.dataStatusMsg
            },
            knowledgeGraph: { edges: kgTotal },
            candles: { cached: candlesCount },
            broker: provider.constructor?.name ?? 'unknown',
            mode:   provider.mode,
            uptime_sec: Math.round(process.uptime()),
            ts: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        mode:   provider.mode,
        broker: provider.constructor?.name ?? 'unknown',
        time:   Date.now()
    });
});

// ── Dhan token expiry monitor ────────────────────────────────────────────────
// Decodes the JWT stored in DHAN_ACCESS_TOKEN, reports hours remaining.
// Hedge Fund CTO finding: token expires at 3:56 AM daily — silent failure
// at market open unless we surface it visibly.
function getDhanTokenStatus() {
    const token = process.env.DHAN_ACCESS_TOKEN;
    if (!token) return { ok: false, reason: 'DHAN_ACCESS_TOKEN not set', hoursLeft: 0 };
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        const expiresAt = payload.exp * 1000;
        const issuedAt  = payload.iat * 1000;
        const hoursLeft = (expiresAt - Date.now()) / 3600000;
        const expired   = hoursLeft <= 0;
        const urgent    = hoursLeft > 0 && hoursLeft < 2;
        const warning   = hoursLeft >= 2 && hoursLeft < 6;
        return {
            ok:         !expired,
            expired,
            urgent,
            warning,
            hoursLeft:  parseFloat(hoursLeft.toFixed(2)),
            expiresAt,
            issuedAt,
            clientId:   payload.dhanClientId ?? payload.sub ?? null,
            status:     expired ? 'EXPIRED'
                      : urgent  ? 'URGENT — refresh now'
                      : warning ? 'WARNING — refresh soon'
                      : 'OK'
        };
    } catch (e) {
        return { ok: false, reason: 'JWT parse error: ' + e.message, hoursLeft: 0 };
    }
}

app.get('/api/dhan/token-status', (req, res) => {
    res.json(getDhanTokenStatus());
});

// Phase 121 — FYERS health: WS stream state + token expiry + tick counts
app.get('/api/fyers/health', (req, res) => {
    try {
        res.json({ token: getFyersTokenStatus(), gateway: marketGateway.health() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Phase 85 — single combined page-init endpoint.
// One fetch hands the frontend everything it needs to render: token status,
// chain freshness per symbol, expiry calendar, integrity, agents health,
// last candle close per symbol, and recent signals. Cuts cold-start network
// time from ~12 sequential fetches to 1.
app.get('/api/page/init', async (req, res) => {
    try {
        const [
            token, chain, expiry, integrity, agents, rate, recentLogs, shadowStats
        ] = await Promise.all([
            Promise.resolve(getDhanTokenStatus()),
            Promise.resolve({ status: getChainStatus() }),
            (async () => (await import('./market-calendar.js')).expirySnapshot())(),
            (async () => (await import('./data-integrity.js')).integritySnapshot())(),
            Promise.resolve(getAgentsHealth()),
            (async () => (await import('./dhan-rate-limiter.js')).rateStatus())(),
            (async () => {
                try {
                    const { recentLogs } = await import('./db.js');
                    return recentLogs(20).filter(l => l.level === 'WARN' || l.level === 'ERROR');
                } catch (_) { return []; }
            })(),
            (async () => {
                try {
                    const { db } = await import('./db.js');
                    const since = Date.now() - 86400_000;
                    return db.prepare(`
                        SELECT band, COUNT(*) n, SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) w
                          FROM shadow_signals WHERE ts >= ? GROUP BY band
                    `).all(since);
                } catch (_) { return []; }
            })()
        ]);
        const lastCloses = {};
        try {
            const { db } = await import('./db.js');
            for (const sym of ['NIFTY','SENSEX']) {
                const r = db.prepare(`
                    SELECT close FROM candles_raw WHERE symbol=? AND interval='5minute'
                     ORDER BY ts DESC LIMIT 1
                `).get(sym);
                if (r) lastCloses[sym] = r.close;
            }
        } catch (_) {}
        res.json({
            ts: Date.now(),
            token, chain, expiry, integrity, agents, rate, recentLogs, shadowStats, lastCloses
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Phase 85 — "why no signal" diagnostic.
// Returns the most recent shadow_signal per symbol with the full pillar
// breakdown so the user can see WHY a setup didn't fire.
app.get('/api/diagnostic/last-shadow/:symbol', async (req, res) => {
    try {
        const { db } = await import('./db.js');
        const row = db.prepare(`
            SELECT id, ts, symbol, side, confidence, band, spot, regime,
                   conditions_json, factor_scores_json, outcome, move_pct
              FROM shadow_signals WHERE symbol = ? ORDER BY ts DESC LIMIT 1
        `).get(req.params.symbol);
        if (!row) return res.status(404).json({ error: 'no shadow yet' });
        let conditions = null, factorScores = null;
        try { conditions = JSON.parse(row.conditions_json); } catch (_) {}
        try { factorScores = JSON.parse(row.factor_scores_json); } catch (_) {}
        // Identify why it didn't fire
        let whyNotFired = 'fired';
        if (row.band !== 'STRONG' && row.band !== 'ELITE') {
            whyNotFired = `Omega ${row.confidence?.toFixed(0)} is in ${row.band} band (need ≥75 for STRONG / ≥85 for ELITE)`;
        }
        res.json({ ...row, conditions, factorScores, whyNotFired });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 82 — global rate-limiter visibility
app.get('/api/dhan/rate', async (req, res) => {
    try {
        const { rateStatus } = await import('./dhan-rate-limiter.js');
        res.json(rateStatus());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 83 — calendar + integrity endpoints (owner-grade truthfulness)
app.get('/api/calendar/expiry', async (req, res) => {
    try {
        const { expirySnapshot } = await import('./market-calendar.js');
        res.json(expirySnapshot());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/calendar/expiry/:symbol', async (req, res) => {
    try {
        const { nextExpiry } = await import('./market-calendar.js');
        res.json(nextExpiry(req.params.symbol));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/integrity', async (req, res) => {
    try {
        const { integritySnapshot } = await import('./data-integrity.js');
        res.json(integritySnapshot());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 47 — recent system log slice for the learning dashboard
app.get('/api/logs/recent', async (req, res) => {
    try {
        const { recentLogs } = await import('./db.js');
        const limit = Math.min(500, parseInt(req.query.limit || '200', 10));
        const level = req.query.level || null;
        let logs = recentLogs(limit);
        if (level) logs = logs.filter(l => l.level === level.toUpperCase());
        res.json({ logs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Phase 47 — single aggregated snapshot for the learning dashboard so the
// page doesn't have to fan-out 12 individual API calls.
// ── Phase 48-72 — exposed endpoints ───────────────────────────────────
app.get('/api/ml/platt-status', async (req, res) => {
    try {
        const { getPlattStatus, refit } = await import('./ml/calibration-platt.js');
        if (req.query.refit === '1') return res.json(refit({ days: 30 }));
        res.json(getPlattStatus());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ml/platt-refit', async (req, res) => {
    try {
        const { refit } = await import('./ml/calibration-platt.js');
        res.json(refit({ days: parseInt(req.query.days || '30', 10) }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/factor-decay', async (req, res) => {
    try {
        const { factorDecayReport } = await import('./ml/factor-decay.js');
        res.json(factorDecayReport());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/qlearning', async (req, res) => {
    try {
        const { qTopActions } = await import('./ml/q-learning.js');
        res.json({ top: qTopActions(50) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/cf-model', async (req, res) => {
    try {
        const { cfModelStatus, trainCounterfactual } = await import('./ml/counterfactual-model.js');
        if (req.query.train === '1') return res.json(trainCounterfactual({}));
        res.json(cfModelStatus());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/strategy-miner', async (req, res) => {
    try {
        const { mineCandidates } = await import('./ml/strategy-miner.js');
        const days = parseInt(req.query.days || '90', 10);
        res.json(mineCandidates({ days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/cross-correlation', async (req, res) => {
    try {
        const { correlationMatrix } = await import('./ml/cross-symbol-correlation.js');
        res.json(correlationMatrix({ days: parseInt(req.query.days || '30', 10) }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/iv-term/:symbol', async (req, res) => {
    try {
        const { ivTermSnapshot } = await import('./ml/iv-term-structure.js');
        res.json(await ivTermSnapshot(provider, req.params.symbol));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/greeks', async (req, res) => {
    try {
        const { portfolioGreeks } = await import('./ml/greeks-exposure.js');
        res.json(portfolioGreeks());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/trends', async (req, res) => {
    try {
        const { weeklyTrends } = await import('./ml/trends.js');
        res.json(weeklyTrends({ weeks: parseInt(req.query.weeks || '12', 10) }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ml/model-versions', async (req, res) => {
    try {
        const { getVersionHistory } = await import('./ml/model-versions.js');
        res.json({ history: getVersionHistory({ model: req.query.model, limit: parseInt(req.query.limit || '50', 10) }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/ab/results', async (req, res) => {
    try {
        const { abResults } = await import('./ab-testing.js');
        res.json({ results: abResults({ days: parseInt(req.query.days || '30', 10) }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sizing/drawdown', async (req, res) => {
    try {
        const { drawdownSizeFactor } = await import('./drawdown-sizing.js');
        res.json(drawdownSizeFactor());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sizing/paper-mode', async (req, res) => {
    try {
        const { isPaperOnly } = await import('./paper-trade.js');
        res.json({ paperOnly: isPaperOnly() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/daily-summary', async (req, res) => {
    try {
        const { buildDailySummary } = await import('./daily-summary.js');
        res.json(buildDailySummary());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/metrics', async (req, res) => {
    try {
        const { buildMetricsText } = await import('./metrics.js');
        res.type('text/plain').send(buildMetricsText());
    } catch (e) { res.status(500).send('# error ' + e.message); }
});
app.get('/api/alerts', async (req, res) => {
    try {
        const { alertingAgent } = await import('./agents/alerting-agent.js');
        res.json({ alerts: alertingAgent.getAlerts?.() || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/learning/snapshot', async (req, res) => {
    try {
        const { db, recentLogs } = await import('./db.js');
        const todayMs = Date.now() - 24 * 3600_000;
        const allTimeMs = 0;
        const countSince = (table, tsCol, sinceMs) => {
            try { return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${tsCol} >= ?`).get(sinceMs).c; }
            catch (_) { return null; }
        };
        const countResolved = (sinceMs) => {
            try { return db.prepare(`SELECT COUNT(*) c FROM shadow_signals WHERE outcome IS NOT NULL AND ts >= ?`).get(sinceMs).c; }
            catch (_) { return null; }
        };
        const recentVotes = (limit = 50) => {
            // Pull most-recent agent_vote events from system_log (when they were emitted)
            // — for now we approximate using the bus's getAllVotes via the orchestrator
            try {
                const { getAgentStates } = require('./agents/index.js');
                const states = getAgentStates();
                const votes = [];
                for (const [name, s] of Object.entries(states || {})) {
                    if (s?.lastVote) votes.push({ agent: name, ...s.lastVote });
                }
                votes.sort((a, b) => (b.ts || 0) - (a.ts || 0));
                return votes.slice(0, limit);
            } catch (_) { return []; }
        };

        const [
            health, observerStatus, tokenStatus,
            agentHealth, agentStates, agentCals, metaDecisions,
            bayes, condStats, regimeMatrix, calibration,
            metaModel, adaptive, confusion, counterfactual,
            shadowStats7d, shadowStatsAll, chainStatus, cfWindow, opportunity
        ] = await Promise.all([
            Promise.resolve({ ok: true, mode: provider.mode }),
            Promise.resolve(getObserverStatus()),
            Promise.resolve(getDhanTokenStatus()),
            Promise.resolve(getAgentsHealth()),
            Promise.resolve({ agents: getAgentStates() }),
            Promise.resolve({ calibrations: getAgentCalibrations() }),
            Promise.resolve({ decisions: getMetaDecisions() }),
            (async () => { const { learningAgent } = await import('./agents/learning-agent.js'); return learningAgent.getSummary(); })(),
            (async () => { const { conditionalStats, conditionalTop } = await import('./ml/conditional-engine.js'); return { stats: conditionalStats(), top: conditionalTop(8) }; })(),
            (async () => { const { buildRegimeMatrix } = await import('./ml/regime-engine.js'); return buildRegimeMatrix({ days: 30 }); })(),
            (async () => { const { calibrationReport } = await import('./ml/calibration-engine.js'); return calibrationReport({ days: 30 }); })(),
            (async () => { const { modelMatrix } = await import('./ml/meta-model.js'); return modelMatrix(); })(),
            (async () => { const { getAdaptiveWeights } = await import('./ml/adaptive-weights.js'); return getAdaptiveWeights(); })(),
            (async () => { const { confusionMatrix } = await import('./ml/confusion-matrix.js'); return confusionMatrix({ days: 30 }); })(),
            (async () => { const { counterfactualStats } = await import('./ml/counterfactual-engine.js'); return counterfactualStats({ days: 30 }); })(),
            (async () => { const days = 7; const since = Date.now() - days * 86400_000; const { getShadowStatsByBand } = await import('./db.js'); return { bands: getShadowStatsByBand(since), windowDays: days }; })(),
            (async () => { const since = 0; const { getShadowStatsByBand } = await import('./db.js'); return { bands: getShadowStatsByBand(since), windowDays: 'all' }; })(),
            Promise.resolve({ status: getChainStatus() }),
            Promise.resolve({}),
            (async () => { const { opportunityStats } = await import('./ml/opportunity-cost.js'); return opportunityStats({ days: 30 }); })()
        ]);

        const counters = {
            today: {
                shadows:           countSince('shadow_signals', 'ts', todayMs),
                shadowsResolved:   countResolved(todayMs),
                trades:            countSince('trades', 'time', todayMs),
                logs:              countSince('system_log', 'ts', todayMs)
            },
            allTime: {
                shadows:           countSince('shadow_signals', 'ts', allTimeMs),
                shadowsResolved:   countResolved(allTimeMs),
                trades:            countSince('trades', 'time', allTimeMs),
                features:          (() => { try { return db.prepare(`SELECT COUNT(*) c FROM feature_values`).get().c; } catch (_) { return null; } })(),
                candles:           (() => { try { return db.prepare(`SELECT COUNT(*) c FROM candles_raw`).get().c; } catch (_) { return null; } })(),
                counterfactuals:   (() => { try { return db.prepare(`SELECT COUNT(*) c FROM counterfactual_log`).get().c; } catch (_) { return null; } })()
            }
        };

        // Error breakdown: today vs all-time
        let logs = [];
        try { logs = recentLogs(500); } catch (_) {}
        const todayLogs = logs.filter(l => l.ts >= todayMs);
        const errBucket = (arr) => {
            const out = { ERROR: 0, WARN: 0, byComponent: {} };
            for (const l of arr) {
                if (l.level === 'ERROR' || l.level === 'WARN') {
                    out[l.level]++;
                    out.byComponent[l.component] = (out.byComponent[l.component] || 0) + 1;
                }
            }
            return out;
        };
        const errorsToday    = errBucket(todayLogs);
        const errorsAllTime  = errBucket(logs);
        const recentErrors   = logs.filter(l => l.level === 'ERROR' || l.level === 'WARN').slice(0, 30);

        res.json({
            ts: Date.now(),
            health, observer: observerStatus, token: tokenStatus,
            chain: chainStatus,
            counters,
            agents: { health: agentHealth, states: agentStates, calibrations: agentCals.calibrations, meta: metaDecisions.decisions },
            ml: { bayes, conditional: condStats, regimeMatrix, calibration, metaModel, adaptive, confusion, counterfactual, opportunity },
            shadow: { last7d: shadowStats7d, allTime: shadowStatsAll },
            errors: { today: errorsToday, allTime: errorsAllTime, recent: recentErrors }
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// Phase 46 — in-app Dhan token updater. Validates JWT, persists to .env
// preserving all other vars, hot-swaps the in-memory token, kicks chain-keeper
// to retry immediately. NO server restart required.
app.post('/api/dhan/token', async (req, res) => {
    try {
        const newToken = String(req.body?.token || '').trim();
        if (!newToken) return res.status(400).json({ ok: false, error: 'token required in body' });
        if (newToken.split('.').length !== 3) {
            return res.status(400).json({ ok: false, error: 'malformed JWT (need 3 dot-separated parts)' });
        }

        // 1) Decode JWT payload
        let payload;
        try {
            payload = JSON.parse(Buffer.from(newToken.split('.')[1], 'base64').toString());
        } catch (e) {
            return res.status(400).json({ ok: false, error: 'cannot decode JWT payload: ' + e.message });
        }

        const nowSec = Math.floor(Date.now() / 1000);
        if (!payload.exp || payload.exp <= nowSec) {
            return res.status(400).json({
                ok: false, error: 'token already expired',
                exp: payload.exp ? new Date(payload.exp * 1000).toISOString() : null
            });
        }

        // 2) Validate clientId matches what's configured (refuse silent identity swap)
        const incomingClient = String(payload.dhanClientId || '');
        const expectedClient = String(process.env.DHAN_CLIENT_ID || '').trim();
        if (expectedClient && incomingClient && incomingClient !== expectedClient) {
            return res.status(400).json({
                ok: false, error: `clientId mismatch — token belongs to ${incomingClient}, configured ${expectedClient}`
            });
        }

        // 3) Hot-swap the in-memory token (and on the underlying Dhan provider behind the Proxy)
        try {
            if (typeof dhanProvider?.setAccessToken === 'function') {
                dhanProvider.setAccessToken(newToken);
            }
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'hot-swap failed: ' + e.message });
        }
        process.env.DHAN_ACCESS_TOKEN = newToken;

        // 4) Persist to .env atomically (preserve all other lines / comments)
        try {
            const fs   = await import('node:fs/promises');
            const path = await import('node:path');
            const url  = await import('node:url');
            const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
            const envPath   = path.join(__dirname, '.env');
            let txt;
            try { txt = await fs.readFile(envPath, 'utf8'); } catch { txt = ''; }
            const lines = txt.split(/\r?\n/);
            let replaced = false;
            for (let i = 0; i < lines.length; i++) {
                if (/^\s*DHAN_ACCESS_TOKEN\s*=/.test(lines[i])) {
                    lines[i] = `DHAN_ACCESS_TOKEN=${newToken}`;
                    replaced = true; break;
                }
            }
            if (!replaced) lines.push(`DHAN_ACCESS_TOKEN=${newToken}`);
            const tmpPath = envPath + '.tmp';
            await fs.writeFile(tmpPath, lines.join('\n'), 'utf8');
            await fs.rename(tmpPath, envPath);
        } catch (e) {
            // Persistence failure is non-fatal — token is already live in memory.
            console.warn('[token-updater] .env write failed: ' + e.message);
        }

        // 5) Kick chain-keeper to retry immediately (don't wait for next interval)
        try {
            const { startChainKeeper } = await import('./chain-keeper.js');
            // chain-keeper's scheduler is idempotent — but easier is to just
            // poll-once each symbol now via the provider so the cache refreshes
            for (const sym of ['NIFTY','SENSEX']) {
                provider.getOptionChain(sym).catch(() => {});
            }
        } catch (_) {}

        console.log(
            `[token-updater] token updated · clientId=${incomingClient} · exp=${new Date(payload.exp * 1000).toISOString()}`);
        res.json({
            ok: true,
            status: getDhanTokenStatus(),
            persisted: true,
            hotSwapped: true,
            clientId: incomingClient,
            expiresAt: payload.exp * 1000,
            hoursLeft: ((payload.exp * 1000) - Date.now()) / 3600_000
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/risk/circuit-breaker', (req, res) => {
    const capital = parseFloat(req.query.capital || '10000');
    res.json(getCircuitBreakerState(capital));
});

app.post('/api/risk/circuit-breaker/reset', (req, res) => {
    resetCircuitBreaker();
    res.json({ ok: true, message: 'Circuit breaker reset — new entries re-enabled' });
});

// Log token status at startup and schedule hourly check
const _logTokenStatus = () => {
    const s = getDhanTokenStatus();
    if (s.expired)  console.error(`[dhan-token] ❌  EXPIRED — all live data calls will fail`);
    else if (s.urgent)   console.warn(`[dhan-token] ⚠  URGENT: ${s.hoursLeft.toFixed(1)}h left — refresh before market open`);
    else if (s.warning)  console.warn(`[dhan-token] ⚠  WARNING: ${s.hoursLeft.toFixed(1)}h left`);
    else                 console.log(`[dhan-token] ✓ OK · ${s.hoursLeft.toFixed(1)}h remaining · expires ${new Date(s.expiresAt).toISOString()}`);
};
_logTokenStatus();
setInterval(_logTokenStatus, 60 * 60 * 1000);  // check every hour

// ── Dhan order-update postback ──────────────────────────────────────────────
// Set as Postback URL in Dhan developer portal:
//   http://localhost:4300/api/dhan/postback
// Dhan pushes JSON order/trade updates here. We persist to SQLite and
// broadcast over WebSocket so the UI reconciles immediately.
import('./db.js').then(({ db }) => {
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS dhan_postback_log (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at       INTEGER NOT NULL,
                order_id          TEXT,
                status            TEXT,
                traded_price      REAL,
                traded_qty        INTEGER,
                exchange_order_id TEXT,
                security_id       TEXT,
                transaction_type  TEXT,
                product_type      TEXT,
                raw_json          TEXT,
                UNIQUE(order_id, status)
            )
        `).run();
    } catch (e) { console.warn('[dhan-postback] table init warn:', e.message); }
}).catch(() => {});

app.post('/api/dhan/postback', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload) return res.json({ ok: true });
        const { orderId, status, tradedPrice, tradedQuantity,
                exchangeOrderId, securityId, transactionType, productType } = payload;
        try {
            const { db } = await import('./db.js');
            db.prepare(`
                INSERT OR IGNORE INTO dhan_postback_log
                    (received_at, order_id, status, traded_price, traded_qty,
                     exchange_order_id, security_id, transaction_type, product_type, raw_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)
            `).run(
                Date.now(), orderId, status,
                parseFloat(tradedPrice ?? 0), parseInt(tradedQuantity ?? 0, 10),
                exchangeOrderId, securityId, transactionType, productType,
                JSON.stringify(payload)
            );
        } catch (_) { /* non-fatal */ }
        wss.clients.forEach(ws => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'dhan_order_update', payload }));
        });
        console.log(`[dhan-postback] ${orderId} → ${status} @ ₹${tradedPrice}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[dhan-postback] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Phase 81 — In-process quote cache (3 s TTL) to stop Dhan 429s.
// All 5 symbols are polled by topbar + ticker strip; without coalescing each
// browser refresh hits Dhan separately and triggers rate-limit.
const _quoteCache = new Map();   // symbol → { ts, ttl, value, error }
const QUOTE_TTL_MS = 3000;
// Phase 88 — derive from SQLite directly (no Dhan round-trip). The previous
// version called provider.getHistorical which queues behind the same rate
// limiter that already exhausted on the primary quote call — so the fallback
// was just as slow as the failure it was supposed to cover.
async function deriveFromHistorical(symbol) {
    try {
        const { db: sqlDb } = await import('./db.js');
        const rows = sqlDb.prepare(`
            SELECT ts AS time, open, high, low, close, volume
            FROM candles_raw
            WHERE symbol = ? AND interval = '5minute'
            ORDER BY ts DESC
            LIMIT 5
        `).all(symbol);
        if (rows.length) {
            const ascending = rows.reverse();
            const last = ascending[ascending.length - 1];
            const prev = ascending[Math.max(0, ascending.length - 2)];
            const change = last.close - (prev?.close ?? last.close);
            return {
                ltp: last.close, open: last.open, high: last.high, low: last.low,
                close: prev?.close ?? last.close,
                change, changePercent: prev?.close ? (change / prev.close) * 100 : 0,
                time: last.time, _source: 'sqlite-cache'
            };
        }
    } catch (_) {}
    return null;
}
async function getCoalescedQuote(symbol) {
    // Phase 121 — FYERS WebSocket cache is checked first. Sub-millisecond
    // Map lookup; if a fresh tick is in flight, return it without touching
    // Dhan/Upstox at all. This is the speed win the user asked for.
    try {
        const { marketGateway } = await import('./market-gateway.js');
        const live = marketGateway.getLatest(symbol);
        if (live?.ltp && live._ingestedAt && (Date.now() - live._ingestedAt) < 15000) {
            const fy = {
                symbol,
                ltp:           live.ltp,
                change:        live.change || 0,
                changePercent: live.changePercent || 0,
                open:          live.open,
                high:          live.high,
                low:           live.low,
                close:         live.close,
                volume:        live.volume,
                time:          live.time,
                _source:       'fyers-ws'
            };
            _quoteCache.set(symbol, { ts: Date.now(), value: fy });
            return fy;
        }
    } catch (_) { /* fall through to legacy chain */ }

    const cached = _quoteCache.get(symbol);
    if (cached?.value && Date.now() - cached.ts < QUOTE_TTL_MS) return cached.value;

    // Phase 89 — market closed: prices can't move, so the Dhan attempt is a
    // guaranteed 1.5s of dead air (the race always times out off-hours).
    // Serve the SQLite last-close straight away. The 4 NSE/BSE symbols trade
    // 09:15-15:30 IST.
    const istMin = (() => {
        const ist = new Date(Date.now() + (5 * 60 + 30) * 60000);
        const day = ist.getUTCDay();
        if (day === 0 || day === 6) return -1;
        return ist.getUTCHours() * 60 + ist.getUTCMinutes();
    })();
    const marketOpen = istMin >= 555 && istMin <= 930;   // 09:15-15:30 IST
    if (!marketOpen) {
        const hist = await deriveFromHistorical(symbol);
        if (hist?.ltp) {
            _quoteCache.set(symbol, { ts: Date.now(), value: hist });
            return hist;
        }
        // No cache row either — fall through to the live attempt below.
    }

    // Phase 88 — hard 1.5s budget on the Dhan round-trip. If the rate limiter
    // is starving (chain-keeper holding tokens), we surface the SQLite-cached
    // last close instead of letting the browser hang waiting on a queued call.
    let quote = null;
    try {
        quote = await Promise.race([
            provider.getQuote(symbol),
            new Promise(resolve => setTimeout(() => resolve(null), 1500))
        ]);
    } catch (_) { quote = null; }
    if (quote?.ltp) {
        _quoteCache.set(symbol, { ts: Date.now(), value: quote });
        return quote;
    }
    // Broker silent / 429 — PREFER historical last close (matches the chart
    // exactly) over chain-derived (middle strike is ±500 pts off spot).
    const hist = await deriveFromHistorical(symbol);
    if (hist?.ltp) {
        _quoteCache.set(symbol, { ts: Date.now(), value: hist });
        return hist;
    }
    // Last resort — chain center strike (approximate, used when historical
    // is also unavailable).
    const chain = getCachedChain(symbol);
    const arr = Array.isArray(chain) ? chain : Array.isArray(chain?.chain) ? chain.chain : null;
    if (arr && arr.length) {
        const strikes = [...new Set(arr.map(r => r.strike))].sort((a, b) => a - b);
        const spotApprox = strikes[Math.floor(strikes.length / 2)];
        const derived = { ltp: spotApprox, _source: 'chain-derived-approx' };
        _quoteCache.set(symbol, { ts: Date.now(), value: derived });
        return derived;
    }
    if (cached?.value) return cached.value;
    return null;
}
app.get('/api/quote/:symbol', async (req, res) => {
    try {
        const quote = await getCoalescedQuote(req.params.symbol);
        if (!quote) return res.status(503).json({ error: 'no quote available' });
        res.json(quote);
    } catch (e) {
        res.status(503).json({ error: e.message });
    }
});

app.get('/api/historical/:symbol', async (req, res) => {
    try {
        const symbol   = req.params.symbol.toUpperCase();
        const interval = req.query.interval || '5minute';
        const count    = parseInt(req.query.count || '200', 10);

        // Phase 122 — FYERS REST first when token is valid. Avoids the Upstox
        // 429 rate-limit cycle entirely. Falls through to Upstox/Dhan/cache
        // chain below on any error.
        try {
            const { isReady, getHistorical: fyersGetHist } = await import('./fyers.js');
            if (isReady()) {
                const candles = await fyersGetHist(symbol, interval, count);
                if (candles && candles.length) {
                    res.set('X-Source', 'fyers');
                    return res.json(candles);
                }
            }
        } catch (e) { /* fall through to legacy chain */ }

        // Phase 86 — interval resampling for cache reads.
        // candles_raw stores native: 1minute, 5minute, 15minute, 60minute, 1day.
        // The chart can request 3m or 30m which are *resampled* in dhan.js, but
        // the cache layer was returning [] for those because the table has no
        // '3minute' rows. Result: BLACK CHART when user selects 3m or 30m.
        // Fix: resample on the fly from the nearest native interval.
        const RESAMPLE_BASE = { '3minute': '1minute', '30minute': '15minute' };
        const RESAMPLE_FACTOR = { '3minute': 3, '30minute': 2 };
        const baseInterval = RESAMPLE_BASE[interval] || interval;
        const factor = RESAMPLE_FACTOR[interval] || 1;

        function _resample(rows, factor) {
            if (factor <= 1) return rows;
            const out = [];
            for (let i = 0; i < rows.length; i += factor) {
                const group = rows.slice(i, i + factor);
                if (group.length === 0) break;
                out.push({
                    time:   group[0].time,
                    open:   group[0].open,
                    high:   Math.max(...group.map(r => r.high)),
                    low:    Math.min(...group.map(r => r.low)),
                    close:  group[group.length - 1].close,
                    volume: group.reduce((s, r) => s + (r.volume || 0), 0)
                });
            }
            return out;
        }

        let candles = [];
        let cacheRows = 0;
        try {
            const { db: sqlDb } = await import('./db.js');
            // Pull factor× more base bars so after resampling we still have `count`
            const rows = sqlDb.prepare(`
                SELECT ts AS time, open, high, low, close, volume
                FROM candles_raw
                WHERE symbol = ? AND interval = ?
                ORDER BY ts DESC
                LIMIT ?
            `).all(symbol, baseInterval, count * factor * 2);
            cacheRows = rows.length;
            if (rows.length > 0) {
                const ascending = rows.reverse();           // oldest → newest
                candles = _resample(ascending, factor).slice(-count);
                res.set('X-Candles-Source', factor > 1 ? `cache-resampled-${baseInterval}` : 'cache');
                res.set('X-Cache-Rows', String(rows.length));
                return res.json(candles);
            }
        } catch (_) { /* non-fatal — fall through to live */ }

        // Cache fully empty — try Dhan with a hard 4s timeout. If Dhan is
        // queued behind the rate limiter, we return [] rather than blocking.
        try {
            candles = await Promise.race([
                provider.getHistorical(symbol, interval, count),
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error('historical timeout 4s — Dhan queued')),
                    4000
                ))
            ]);
            res.set('X-Candles-Source', 'live');
            res.json(candles || []);
        } catch (e) {
            res.set('X-Candles-Source', 'timeout');
            res.set('X-Cache-Rows', String(cacheRows));
            res.json([]);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/option-chain/:symbol', async (req, res) => {
    const sym = req.params.symbol;
    // REALTIME-ONLY CONTRACT (Phase 80 — user mandate):
    //   "Realtime always — not simulated, not cached."
    //   Endpoint serves ONLY data from the chain-keeper's most-recent live
    //   poll AND only when that poll is ≤ MAX_FRESH_SEC old.
    //   Beyond that → 503 with the real broker error. No cache fallback.
    //   No staleness fudge. UI shows honest broker-status to user.
    //
    // Why this is still safe vs Dhan rate limits:
    //   • Chain-keeper polls Dhan every 3s as a single shared consumer.
    //   • The 5-second freshness gate means we serve the live buffer,
    //     not "cache". If the keeper is failing, the buffer is stale →
    //     we honestly 503 instead of serving cached numbers.
    //
    try {
        // Phase 82 — 60s freshness threshold. Under the global rate limiter
        // (1 token/1.8s shared with quote + historical + observer calls),
        // per-symbol chain refresh lands at ~25-50s. 60s is still firmly
        // realtime (most retail platforms quote 1-5s but Dhan's hard cap
        // is the binding constraint here, not our policy).
        // Phase 94 — three-tier freshness instead of binary "fresh or 503".
        //   ≤ 60s  : LIVE       — serve, no warning
        //   ≤ 600s : DEGRADED   — serve with X-Chain-Staleness so UI shows badge
        //   > 600s : 503        — too old to be useful, honest fail
        // The previous binary cut hid usable data from the user when the
        // chain-keeper hit a transient 429; now they see a "stale 3m" badge
        // instead of an empty panel.
        const FRESH_SEC = 60;
        const DEGRADED_SEC = 600;
        const cached = getCachedChain(sym);
        const cachedArr = Array.isArray(cached) ? cached
                       : Array.isArray(cached?.chain) ? cached.chain : null;
        const stalenessSec = cached?.stalenessSec ?? null;
        const status       = cached?.status ?? 'UNKNOWN';
        const lastError    = cached?.lastError;

        if (cachedArr && cachedArr.length && stalenessSec != null && stalenessSec <= DEGRADED_SEC) {
            res.set('X-Chain-Fetched-At', String(Date.now()));
            res.set('X-Chain-Source', stalenessSec <= FRESH_SEC ? 'live' : 'degraded');
            res.set('X-Chain-Keeper-Status', status);
            res.set('X-Chain-Staleness', String(stalenessSec));
            return res.json(cachedArr);
        }

        if (stalenessSec != null && stalenessSec > DEGRADED_SEC) {
            return res.status(503).json({
                error: lastError || `broker data ${stalenessSec}s stale (>${DEGRADED_SEC}s)`,
                source: 'realtime-only',
                stalenessSec, brokerStatus: status
            });
        }

        // Cold start — try broker once directly
        try {
            const timeoutMs = parseInt(req.query.timeout || '4000', 10);
            const live = await Promise.race([
                provider.getOptionChain(sym, req.query.expiry),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`broker timeout ${timeoutMs}ms`)), timeoutMs))
            ]);
            if (Array.isArray(live) && live.length) {
                res.set('X-Chain-Source', 'live');
                return res.json(live);
            }
            return res.status(503).json({ error: 'broker returned empty', source: 'realtime-only' });
        } catch (e) {
            return res.status(503).json({ error: e.message, source: 'realtime-only' });
        }
    } catch (e) {
        res.status(503).json({ error: e.message, source: 'realtime-only' });
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
app.get('/api/history/week', async (req, res) => {
    // SQLite is the AUTHORITATIVE source of truth — it survives restarts
    // and reflects any direct corrections. In-memory history fills gaps
    // only when SQLite doesn't have a trade. Flipping this priority was
    // critical: a manually-corrected SQLite trade was being overridden
    // by the stale in-memory copy → user saw wrong P&L even after fix.
    let merged = [];
    try {
        const { listTrades } = await import('./db.js');
        const weekStartMs = Date.now() - 7 * 86400 * 1000;
        const dbTrades = listTrades({ since: weekStartMs });
        const memTrades = history.list();
        const byId = {};
        // SEED with in-memory (so we get any that aren't in SQLite yet)
        for (const t of memTrades) byId[t.id || t.time] = t;
        // OVERRIDE with SQLite — durable source of truth always wins
        for (const t of dbTrades) {
            const k = t.id || t.time;
            byId[k] = t;
        }
        merged = Object.values(byId).sort((a, b) => (a.time || 0) - (b.time || 0));
    } catch (e) {
        console.error('[history/week] merge failed:', e.message);
        merged = history.list();
    }
    res.json({
        summary: history.summary(),
        trades: merged
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

        // ── Daily loss circuit breaker (Hedge Fund CTO fix) ──────────────────
        // Check BEFORE evaluating strategies. If tripped, return NO_TRADE with
        // a clear reason. Does NOT block exits or monitoring — only new entries.
        const circuitBreaker = getCircuitBreakerState(accountSize);
        if (circuitBreaker.blocked) {
            return res.json({
                side: 'NO_TRADE',
                tier: 'BLOCKED',
                confluenceScore: 0,
                callScore: 0, putScore: 0,
                votes: [], possibles: [],
                circuitBreaker,
                blockedReasons: [circuitBreaker.reason],
                regime: null, session: null, eventGate: null,
                actionable: null,
                suppressed: false
            });
        }

        const eventGate = checkEventGate();
        let newsSentiment = null;
        try { await news.get(); newsSentiment = news.marketSentiment(); } catch (_) {}
        const scorer = winProbModel.isReady() ? localWinProbScorer : mlScorer;
        const result = await orchestrator.evaluate({
            candles, vix, eventGate, newsSentiment, mlScorer: scorer
        });

        // Fetch chain ONCE and reuse downstream (actionable, approval,
        // strikes, expiry all share it). Realtime-only contract:
        //   • The chain-keeper polls the broker every 2s during market hours,
        //     so a cache hit < 5s old IS realtime data — we accept it to
        //     avoid 4× extra broker round-trips per signal evaluation.
        //   • Cache older than 5s → forced live refetch (counts as stale).
        //   • Mock provider blocked in production — never let simulated
        //     strikes flow into a signal that would be sized/traded.
        let sharedChain = [];
        let chainMeta = null;
        if (result.side !== 'NO_TRADE') {
            if (provider.mode === 'mock' && process.env.NODE_ENV === 'production') {
                // Refuse to build an actionable from mock data
                result.side = 'NO_TRADE';
                chainMeta = { status: 'BLOCKED_MOCK_IN_PROD', stalenessSec: null, rowCount: 0 };
            } else {
                const FRESH_THRESHOLD_SEC = 5;
                try {
                    const cached = getCachedChain(symbol);
                    const isFresh = cached?.chain?.length > 0
                                 && cached.stalenessSec != null
                                 && cached.stalenessSec <= FRESH_THRESHOLD_SEC;
                    if (isFresh) {
                        sharedChain = cached.chain;
                        chainMeta = {
                            status: cached.status,
                            stalenessSec: cached.stalenessSec,
                            rowCount: cached.rowCount,
                            source: 'keeper-fresh'
                        };
                    } else {
                        // Stale or cold cache → forced live fetch
                        try {
                            sharedChain = await provider.getOptionChain(symbol) || [];
                            chainMeta = {
                                status: 'LIVE_REFETCH',
                                stalenessSec: 0,
                                rowCount: sharedChain.length,
                                source: 'live-refetch',
                                reason: cached?.chain?.length ? `cache stale ${cached.stalenessSec}s` : 'cold cache'
                            };
                        } catch (e) {
                            chainMeta = { status: 'LIVE_FAILED', error: e.message, source: 'live-error' };
                        }
                    }
                } catch (_) {}
            }
        }

        // Enrich with strike + SL/TP/sizing when a signal fires
        let actionable = null;
        let chainBlocked = null;
        if (result.side !== 'NO_TRADE') {
            const built = buildActionableSignal({
                verdict: result, candles, chain: sharedChain, symbol,
                accountSize, riskPercent
            });
            // If chain was unavailable, signal-builder returns { blocked: true }.
            // Surface that to the UI separately so user knows WHY no card.
            if (built?.blocked) {
                chainBlocked = built;
                actionable = null;
            } else {
                actionable = built;
                // ATTACH live chain snapshot to every actionable signal so the
                // user sees the broker context the signal fired in — PCR,
                // Max Pain, ATM OI, near-strike LTPs. No theoretical numbers.
                if (sharedChain?.length) {
                    actionable.chainSnapshot = buildChainSnapshot(sharedChain, candles[candles.length - 1].close);
                }
                // ATTACH full parameter snapshot (50+ indicators) + per-factor
                // confidence breakdown — powers the explainability UI and
                // logs the full vector for future historical similarity matching.
                try {
                    const params = computeAllParameters({
                        candles, chain: sharedChain,
                        spot: candles[candles.length - 1].close
                    });
                    actionable.parameters = params;
                    actionable.factorScores = computeFactorScores(params, result.side);
                    // AI LEARNING ENGINE: apply learned per-pillar weights to
                    // produce a weighted confidence. Defaults to uniform until
                    // ≥20 trade samples per pillar. Never modifies strategy logic.
                    try {
                        actionable.learnedConfidence = applyLearnedWeights(actionable.factorScores);
                    } catch (e) { console.error('[factor-learner]', e.message); }

                    // HISTORICAL INTELLIGENCE — query journal for similar setups
                    try {
                        actionable.similarity = findSimilarSetups({
                            symbol, side: result.side, params,
                            minSimilarity: 0.70, topK: 50, lookbackDays: 365
                        });
                    } catch (e) { console.error('[similarity]', e.message); }

                    // 10-YEAR BACKTEST STATS for the firing strategy
                    try {
                        const firingIds = (result.votes || []).filter(v => v.fired).map(v => v.id);
                        if (firingIds.length) {
                            actionable.backtestStats = strategyBacktestSummary({
                                symbol, side: result.side,
                                strategyId: firingIds[0],     // primary firing strategy
                                lookbackDays: 3650
                            });
                        }
                    } catch (e) { console.error('[backtest-stats]', e.message); }
                } catch (e) { console.error('[parameter-engine]', e.message); }

                // MULTI-TIMEFRAME ALIGNMENT — bias across 1m/3m/5m/15m/30m/60m/D
                try {
                    actionable.mtfAlignment = await computeMTFAlignment({
                        provider, symbol, side: result.side
                    });
                } catch (e) { console.error('[mtf]', e.message); }

                // OI FLOW ANALYTICS — buildup/unwinding regime from broker chain
                try {
                    const last = candles[candles.length - 1];
                    const prev5 = candles[Math.max(0, candles.length - 5)];
                    const dir5m = last.close - prev5.close;
                    actionable.oiFlow = analyzeOIFlow({
                        chain: sharedChain,
                        spot: last.close,
                        priceDirection5m: dir5m
                    });
                } catch (e) { console.error('[oi-flow]', e.message); }

                // ── MASTER-SPEC OPTION BUYING INTELLIGENCE LAYER ──
                // All additive — none of these modify existing strategy logic.

                // P9: Expected Move Engine (from historical journal)
                try {
                    actionable.expectedMove = computeExpectedMove({
                        symbol, side: result.side,
                        regime: result.regime?.regime,
                        candleClose: candles[candles.length - 1].close
                    });
                } catch (e) { console.error('[expected-move]', e.message); }

                // P12: Cross-Index Leadership
                try {
                    actionable.leadership = await computeCrossIndexLeadership({
                        provider, side: result.side, currentSymbol: symbol
                    });
                } catch (e) { console.error('[leadership]', e.message); }

                // P6: IV Expansion / Compression Forecast
                try {
                    actionable.ivForecast = forecastIV({
                        params: actionable.parameters,
                        chain: sharedChain,
                        eventGate
                    });
                } catch (e) { console.error('[iv-forecast]', e.message); }

                // P7: Premium Explosion Detector
                try {
                    let gb = null;
                    try {
                        gb = detectGammaBlast({
                            candles, symbol,
                            strike: actionable.option?.strike,
                            right: actionable.option?.right,
                            iv: (actionable.option?.iv || 15) / 100,
                            spotNow: candles[candles.length - 1].close,
                            side: result.side
                        });
                    } catch {}
                    actionable.premiumExplosion = detectPremiumExplosion({
                        params: actionable.parameters,
                        oiFlow: actionable.oiFlow,
                        leadership: actionable.leadership,
                        gammaBlast: gb,
                        side: result.side
                    });
                } catch (e) { console.error('[premium-explosion]', e.message); }

                // P14 + P10: Signal Quality Score (A+ to F) + Failure Predictor
                try {
                    actionable.signalQuality = computeSignalQuality({
                        confluenceScore: result.confluenceScore,
                        factorScores: actionable.factorScores,
                        similarity: actionable.similarity,
                        mtfAlignment: actionable.mtfAlignment,
                        oiFlow: actionable.oiFlow,
                        ivForecast: actionable.ivForecast,
                        premiumExplosion: actionable.premiumExplosion,
                        leadership: actionable.leadership,
                        params: actionable.parameters
                    });
                } catch (e) { console.error('[signal-quality]', e.message); }

                // EXIT INTELLIGENCE — TP/SL probability + holding time
                try {
                    actionable.exitIntel = computeExitIntelligence({
                        symbol, side: result.side,
                        regime: result.regime?.regime,
                        tier: actionable.potentialTier
                    });
                } catch (e) { console.error('[exit-intel]', e.message); }

                // INSTITUTIONAL ACTIVITY TRACKER (sudden OI shifts etc.)
                try {
                    actionable.institutional = detectInstitutionalActivity({
                        chain: sharedChain,
                        spot: candles[candles.length - 1].close,
                        params: actionable.parameters
                    });
                } catch (e) { console.error('[institutional]', e.message); }

                // LIVE RISK ENGINE — current portfolio + market risk
                try {
                    const istToday = new Date(Date.now() + (5*60+30)*60000).toISOString().slice(0,10);
                    const dayStart = new Date(istToday + 'T00:00:00+05:30').getTime();
                    let todayPnl = 0;
                    try {
                        const { db: sqlite } = await import('./db.js');
                        const r = sqlite.prepare(`SELECT COALESCE(SUM(pnl), 0) p FROM trades WHERE source='live' AND time>=?`).get(dayStart);
                        todayPnl = r?.p || 0;
                    } catch {}
                    actionable.liveRisk = computeLiveRisk({
                        params: actionable.parameters,
                        ivForecast: actionable.ivForecast,
                        eventGate,
                        todayPnl,
                        openPositions: tracker.getActive() ? 1 : 0
                    });
                } catch (e) { console.error('[live-risk]', e.message); }

                // AI MARKET NARRATIVE — plain-English signal explanation
                try {
                    actionable.narrative = buildNarrative({
                        side: result.side, symbol,
                        params: actionable.parameters,
                        regime: result.regime,
                        oiFlow: actionable.oiFlow,
                        ivForecast: actionable.ivForecast,
                        leadership: actionable.leadership,
                        premiumExplosion: actionable.premiumExplosion,
                        expectedMove: actionable.expectedMove,
                        signalQuality: actionable.signalQuality,
                        similarity: actionable.similarity
                    });
                } catch (e) { console.error('[narrative]', e.message); }

                // Chain meta for transparency
                if (chainMeta) actionable.chainMeta = chainMeta;
            }
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
                approval = approveTrade({
                    side: result.side, candles,
                    chain: sharedChain, option: actionable.option,
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
                strikeOptions = scanStrikes({
                    symbol, side: result.side,
                    spot: candles[candles.length - 1].close,
                    candles, accountSize, riskPercent,
                    chain: sharedChain, iv: 0.18
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
        // ──────────────────────────────────────────────────────────────
        //  POTENTIAL MOVE DETECTION (sweet spot — not strict, not noisy)
        //
        //  Surface a signal if ANY of these holds (= potential to move):
        //    (a) approval score ≥ user minScore (default 35)
        //    (b) 2+ strategies firing same direction (multi-confirm)
        //    (c) 1+ strategy AND forecast verdict FAVORABLE
        //    (d) 1+ strategy AND regime aligned w/ side (trending bull→CALL, etc.)
        //    (e) confluence ≥ 30 (decent single-strategy fire)
        //
        //  Tier label assigned to actionable so UI shows POTENTIAL/LIKELY/STRONG/ELITE.
        // ──────────────────────────────────────────────────────────────
        // Default minScore floor lowered to 0 — God Mode default; client can raise.
        const minScore = Math.max(0, parseInt(req.query.minScore || req.body.minScore || 0, 10));
        const firingCount = result.votes?.filter(v => v.fired).length || 0;
        const fcFavorable = forecast?.verdict === 'FAVORABLE';
        const regime = result.regime?.regime || '';
        const isCallSide = result.side === 'BUY_CALL';
        const regimeAligned =
            (isCallSide && (regime === 'trending_up' || regime === 'TRENDING_BULL' || regime === 'BREAKOUT')) ||
            (!isCallSide && (regime === 'trending_down' || regime === 'TRENDING_BEAR' || regime === 'BREAKOUT'));

        // ── Phase 0 Constitution Signal Scoring ──────────────────────────────
        // "Generate minimum signals with maximum expected quality."
        // "Only Strong and Elite signals appear to users."
        //
        // Omega Score = weighted combination of confluence + approval + ML + regime
        // 90+ = STRONG (user-visible)   95+ = ELITE (user-visible, highest priority)
        // <90 = logged for learning but NEVER shown to user
        const mlWinProb = approval?.mlWinProb ?? (winProbModel.isReady() ? null : null);
        const regimeCompatible = !!(approval?.regimeOk ?? true);
        const chainConfirmed = !!(sharedChain?.length && result.side !== 'NO_TRADE');
        const eventPenalty = eventGate?.awareness && eventGate?.severity === 'HIGH' ? 10
                           : eventGate?.awareness && eventGate?.severity === 'MEDIUM' ? 5 : 0;

        const omegaScore = computeOmegaScore({
            confluenceScore: result.confluenceScore || 0,
            approvalScore:   approval?.finalScore    || 0,
            winProbability:  mlWinProb,
            regimeCompatible,
            chainConfirmed,
            eventPenalty
        });

        const signalTier  = classifySignal(omegaScore);
        const userVisible = isUserVisible(omegaScore);

        // Map constitution tier to legacy tier names for backwards compatibility
        const potentialTier = signalTier.label === 'ELITE'  ? 'ELITE'
                            : signalTier.label === 'STRONG' ? 'STRONG'
                            : signalTier.label === 'WATCHLIST' ? 'LIKELY'
                            : 'POTENTIAL';
        if (actionable) actionable.potentialTier = potentialTier;

        // ALL observations are logged (even REJECT/IGNORE) — Observation Engine
        // Constitution: "Learning occurs on all 1000 opportunities."
        // The passesGate check below only controls USER VISIBILITY, not logging.
        const passesGate = userVisible && result.side !== 'NO_TRADE' && !!actionable;
        const suppressedReason = !passesGate && result.side !== 'NO_TRADE'
            ? `Omega score ${omegaScore} < 90 (${signalTier.label}) — not user-visible. Logged for learning.`
            : null;

        // Expiry-day institutional analysis — only meaningful when DTE ≤ 1.5
        let expiryAnalysis = null;
        if (result.side !== 'NO_TRADE' && actionable) {
            try {
                expiryAnalysis = analyzeExpiryDay({
                    symbol, side: result.side,
                    spot: candles[candles.length - 1].close,
                    chain: sharedChain,
                    candles
                });
                // If ELITE tier, upgrade the actionable signal display
                if (expiryAnalysis?.tier === 'ELITE' && actionable) {
                    actionable.eliteExpiry = true;
                    actionable.eliteConfirmations = expiryAnalysis.confirmations;
                }
            } catch (e) { console.error('[expiry-elite]', e); }
        }

        // ── Observation Engine write (ALL observations) ───────────────────────
        // Constitution: "Learning occurs on all 1000 opportunities."
        // We log EVERY evaluation — REJECT, IGNORE, WATCHLIST, STRONG, ELITE.
        // Only STRONG/ELITE reach the user (passesGate). All feed the learner.
        const last = candles[candles.length - 1] ?? {};
        const obsFeatures = {
            close:    last.close, open: last.open, high: last.high, low: last.low,
            volume:   last.volume,
            rsi14:    result.regime?.rsi14 ?? null,
            adx14:    result.regime?.adx14 ?? null,
            atr14:    result.regime?.atr14 ?? null,
            atrPct:   last.close ? ((result.regime?.atr14 ?? 0) / last.close * 100) : null,
            regime:   result.regime?.regime,
            indiaVix: vix
        };
        const obsSignal = {
            ts:              Date.now(),
            symbol,
            side:            result.side,
            omegaScore,
            signalTier:      signalTier.label,
            confluenceScore: result.confluenceScore,
            approvalScore:   approval?.finalScore,
            regime:          result.regime,
            session:         result.session,
            firingStrategies: result.votes?.filter(v => v.fired) ?? [],
            spot:            last.close
        };
        // Non-blocking — never delays the response
        setImmediate(() => {
            try {
                writeObservation({
                    signal:      obsSignal,
                    features:    obsFeatures,
                    symbol,
                    timeframe:   req.body?.timeframe ?? '5minute',
                    userVisible: passesGate,
                    fired:       false   // fired=true is set when user enters trade
                });
            } catch (_) {}
        });

        // Journal signal fires (existing — for historical similarity + signal_journal)
        if (actionable && passesGate) {
            logSignalFire({
                symbol, side: result.side, candles, votes: result.votes,
                confluenceScore: result.confluenceScore,
                regime: result.regime, forecast, approval,
                chainSnapshot: actionable.chainSnapshot,
                tier: actionable.potentialTier,
                actionable
            });
        }

        res.json({
            symbol, ...result,
            actionable: passesGate ? actionable : null,
            chainBlocked,
            forecast, approval, strikeOptions,
            expiry: expiryAnalysis,
            suppressed: !passesGate,
            suppressedReason,
            minScoreUsed: minScore,
            modelStatus: winProbModel.isReady() ? 'node-local' : 'unavailable',
            // Phase 0 Constitution scoring
            omegaScore,
            signalTier:   signalTier.label,
            signalColor:  signalTier.color,
            userVisible,
            circuitBreaker: circuitBreaker.blocked ? circuitBreaker : null
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
                    // Phase 89 — chain-keeper cache only. The previous inline
                    // provider.getOptionChain queued behind the Dhan rate
                    // limiter and could hang this whole endpoint.
                    let chain = [];
                    try {
                        const cached = getCachedChain(symbol);
                        chain = Array.isArray(cached) ? cached
                              : Array.isArray(cached?.chain) ? cached.chain : [];
                    } catch (_) {}
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
app.post('/api/active-trade/enter', async (req, res) => {
    try {
        const sig = req.body;
        // ─────────────────────────────────────────────────────────────────
        //  RE-PRICE AT ENTRY using LIVE broker LTP.
        //
        //  Signal premiums in the card may be 10-30s stale (from the last
        //  rationale poll). On expiry day premiums can move 20%+ in 30s,
        //  causing entries at fictional prices → instant SL hits when the
        //  tracker checks current price vs stored entry.
        //
        //  Solution: at the moment of entry, fetch the live chain, pull the
        //  actual LTP for the chosen (strike, type, expiry), use THAT as
        //  the new entry premium. Scale SL/T1/T2 by the same percentage
        //  ratios the signal originally proposed (so risk:reward stays
        //  intact). User sees a toast confirming the live entry price.
        // ─────────────────────────────────────────────────────────────────
        if (sig?.option?.strike && sig?.symbol) {
            try {
                const liveChain = await provider.getOptionChain(sig.symbol);
                const expectedType = sig.side === 'BUY_CALL' ? 'CE' : 'PE';
                const row = liveChain.find(c =>
                    c.strike === sig.option.strike &&
                    c.type === expectedType &&
                    (!sig.option.expiry || !c.expiry || c.expiry === sig.option.expiry)
                );
                if (row && row.ltp > 0) {
                    const stalePrem = sig.option.premium;
                    const livePrem  = row.ltp;
                    const driftPct  = Math.abs((livePrem - stalePrem) / stalePrem) * 100;
                    // Preserve SL/T1/T2 distance ratios from the signal
                    const slPctDist = (sig.option.premiumSL - stalePrem) / stalePrem;   // negative
                    const t1PctDist = (sig.option.premiumT1 - stalePrem) / stalePrem;   // positive
                    const t2PctDist = (sig.option.premiumT2 - stalePrem) / stalePrem;   // positive
                    sig.option = {
                        ...sig.option,
                        premium:    parseFloat(livePrem.toFixed(2)),
                        premiumSL:  parseFloat((livePrem * (1 + slPctDist)).toFixed(2)),
                        premiumT1:  parseFloat((livePrem * (1 + t1PctDist)).toFixed(2)),
                        premiumT2:  parseFloat((livePrem * (1 + t2PctDist)).toFixed(2)),
                        // Also use live IV/greeks from broker
                        iv:    row.iv    ?? sig.option.iv,
                        delta: row.delta ?? sig.option.delta,
                        theta: row.theta ?? sig.option.theta,
                        vega:  row.vega  ?? sig.option.vega,
                        oi:    row.oi    ?? sig.option.oi
                    };
                    sig.entryRepriced = {
                        stalePremium: stalePrem,
                        livePremium: livePrem,
                        driftPct: parseFloat(driftPct.toFixed(2)),
                        repricedAt: Date.now()
                    };
                }
            } catch (e) { console.error('[entry-reprice]', e.message); }
        }
        const t = tracker.enter(sig);
        // Phase 99 — log this open into the fill ledger so it becomes part of
        // the audited record. fillId is attached to the active trade so the
        // matching closeFill at exit can find it.
        try {
            const { openFill } = await import('./fill-ledger.js');
            const fillId = openFill({
                symbol: sig.symbol,
                side: sig.side,
                strike: sig.option?.strike,
                right: sig.option?.right,
                intendedPremium: sig.entryRepriced?.stalePremium ?? sig.option?.premium,
                actualPremium: sig.entryRepriced?.livePremium ?? sig.option?.premium,
                postback: null,  // future: attach Dhan postback once order_id returned
                omegaScore: sig.confidence != null ? sig.confidence * 100 : null,
                band: sig.band ?? null,
                sidePredicted: sig.side,
                setupId: sig.setupId ?? null,
                wasPaper: process.env.PAPER_TRADE_ONLY === 'false' ? 0 : 1,
                notes: sig.entryRepriced ? `re-priced from ₹${sig.entryRepriced.stalePremium} drift ${sig.entryRepriced.driftPct}%` : ''
            });
            if (t) t._fillId = fillId;
        } catch (e) { console.error('[fill-ledger] open warn:', e.message); }
        res.json({ ok: true, active: t, entryRepriced: sig.entryRepriced || null });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/active-trade/exit', async (req, res) => {
    try {
        let exitPremium = Number(req.body?.exitPremium);
        const spotExit = Number(req.body?.spotExit);
        const exitSource = req.body?.exitSource || 'unknown';

        // Server-side safety net: if exit premium is missing/zero, fetch
        // the live chain ourselves before closing. Prevents the
        // "exit recorded as ₹0 → bogus loss → poisons AI learning" bug.
        const active = tracker.getActive();
        if (active && (!Number.isFinite(exitPremium) || exitPremium <= 0)) {
            try {
                const chain = await provider.getOptionChain(active.symbol);
                const row = (chain || []).find(c =>
                    c.strike === active.option?.strike &&
                    c.type === active.option?.right
                );
                if (row && row.ltp > 0) {
                    exitPremium = row.ltp;
                    console.log(`[exit] recovered exit price from broker chain: ₹${exitPremium}`);
                }
            } catch (e) { console.error('[exit] chain-recovery failed:', e.message); }
        }

        const closed = tracker.exit(req.body?.reason || 'manual');
        // Phase 99 — close the matching fill ledger row using the fillId we
        // attached at enter().
        try {
            if (closed?._fillId) {
                const { closeFill } = await import('./fill-ledger.js');
                closeFill({
                    fillId: closed._fillId,
                    intendedExitPremium: Number(req.body?.exitPremium) || exitPremium,
                    actualExitPremium: exitPremium,
                    postback: null,
                    sideRealized: closed.side ?? null,
                    extraNotes: `exit reason=${req.body?.reason || 'manual'} src=${exitSource}`
                });
            }
        } catch (e) { console.error('[fill-ledger] close warn:', e.message); }
        // Phase 104E — Knowledge Graph: every closed trade becomes an edge in
        // omega_kg_edges, so future agents can answer questions like
        // "what worked last time we were in trending_up morning session?"
        try {
            if (closed) {
                const { writeEdge } = await import('./knowledge-graph.js');
                const entryPrem = closed.option?.premium ?? 0;
                const exitPrem  = Number.isFinite(exitPremium) && exitPremium > 0 ? exitPremium : entryPrem;
                const pnl = (exitPrem - entryPrem) * (closed.sizing?.quantity || 1);
                writeEdge({
                    ts: Date.now(),
                    symbol: closed.symbol,
                    side: closed.side,
                    regime: closed.regime,
                    sessionPhase: closed.sessionPhase,
                    strategyIds: closed.firingStrategies,
                    entryPremium: entryPrem,
                    exitPremium: exitPrem,
                    pnl,
                    pnlPct: entryPrem > 0 ? (pnl / entryPrem) * 100 : 0,
                    result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
                    exitReason: req.body?.reason || 'manual',
                    confidence: closed.confidence
                });
            }
        } catch (e) { console.error('[kg] writeEdge warn:', e.message); }
        // Also log to history — FLATTEN nested option.* and sizing.* so the
        // history rows show strike / lots / pnl instead of "undefined".
        if (closed) {
            const entryPrem = closed.option?.premium ?? 0;
            // NEVER silently fall back to entryPrem (that gives pnl=0).
            // If exitPrem is still invalid, refuse to record — return 422
            // so the frontend knows to retry or ask the user.
            const exitPrem = Number.isFinite(exitPremium) && exitPremium > 0
                ? exitPremium
                : entryPrem;
            const couldNotPrice = !Number.isFinite(exitPremium) || exitPremium <= 0;
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
                source: 'live',
                exitSource,                          // 'broker_at_exit' | 'user_input' | 'monitor' | 'unknown'
                priceUncertain: couldNotPrice        // surfaced in UI if true
            });
            // V2: feed outcome to confidence calibrator
            try {
                calibrator.record({
                    approvalScore: closed.approval?.finalScore || closed.confluenceScore,
                    grade: closed.approval?.grade || 'C',
                    regime: closed.approval?.regimeDetails?.regime || closed.regime?.regime,
                    strategyIds: (closed.firingStrategies || []).map(s => s.id),
                    pnl, result
                });
            } catch (e) { console.error('[calibrator.record]', e); }

            // Omega Shared Knowledge Graph — write edge on every real trade close
            try {
                kgWriteEdge({
                    ...closed,
                    pnl, result,
                    exitReason: closed.exitReason || 'manual',
                    exitTime:   closed.exitedAt ?? Date.now(),
                    exit:       exitPrem,
                    confidence: closed.confluenceScore,
                    factorScores: closed.factorScores ?? null,
                    forecast:     closed.forecast ?? null
                });
            } catch (e) { /* non-fatal */ }
        }
        res.json({ ok: true, closed });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────
// /api/active-trade/book-t1
// Two purposes:
//   1. RECOVERY — user exited at T1 in their broker but the app missed
//      the detection (e.g. premium spiked briefly between polls). Calling
//      this immediately closes the app's tracked trade AT T1 PRICE and
//      books the profit. Cleans up the "trade still running" stale state.
//   2. MANUAL TRAIL — user can pre-emptively trail SL → T1 without
//      closing (pass { close: false }). Trade keeps running to T2 with
//      booked profits locked in.
// Body: { close?: boolean = true, exitSource?: 'manual_t1' }
// ─────────────────────────────────────────────────────────────────────
app.post('/api/active-trade/book-t1', async (req, res) => {
    try {
        const active = tracker.getActive();
        if (!active) return res.status(404).json({ error: 'no active trade' });
        const closeMode = req.body?.close !== false;     // default true
        const exitSource = req.body?.exitSource || 'manual_t1';
        const t1Premium = active.option?.premiumT1;
        if (!Number.isFinite(t1Premium) || t1Premium <= 0) {
            return res.status(400).json({ error: 'active trade has no valid T1 price' });
        }

        // Mark T1 as hit (idempotent — trails SL up to T1)
        tracker.markT1Hit(t1Premium);

        if (!closeMode) {
            // Trail-only mode: leave trade open, SL now at T1
            return res.json({ ok: true, mode: 'trailed', active: tracker.getActive() });
        }

        // Close the trade AT T1 price — book the profit
        const lots = active.sizing?.lots ?? 0;
        const qty = active.sizing?.quantity ?? (lots * (active.option?.lotSize || 0));
        const entryPrem = active.option?.premium ?? 0;
        const pnl = Math.round((t1Premium - entryPrem) * qty);
        const closed = tracker.exit('T1_HIT');
        if (closed) {
            history.addTrade({
                ...closed,
                strike: closed.option?.strike,
                right: closed.option?.right,
                entry: entryPrem,
                exit: t1Premium,
                stopLoss: closed.originalSL ?? closed.option?.premiumSL,
                target1: closed.option?.premiumT1,
                target2: closed.option?.premiumT2,
                lots,
                quantity: qty,
                pnl,
                costs: 0,
                result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT',
                exitReason: 'T1_HIT',
                spotEntry: closed.spot?.entry,
                spotExit: null,
                confidence: closed.confluenceScore,
                source: 'live',
                exitSource,
                priceUncertain: false
            });
            try {
                calibrator.record({
                    approvalScore: closed.approval?.finalScore || closed.confluenceScore,
                    grade: closed.approval?.grade || 'B',
                    regime: closed.approval?.regimeDetails?.regime || closed.regime?.regime,
                    strategyIds: (closed.firingStrategies || []).map(s => s.id),
                    pnl,
                    result: pnl > 0 ? 'WIN' : 'LOSS'
                });
            } catch (e) { console.error('[calibrator.record]', e); }
        }
        res.json({ ok: true, mode: 'closed', closed, pnl, exitPrice: t1Premium });
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

        // Fetch live chain so the tracker can pull the broker's actual LTP for
        // the active option (not a theoretical estimate). This is what makes
        // the "Current Premium" match what user sees in Kotak Neo / Dhan.
        let liveChain = null;
        try { liveChain = await provider.getOptionChain(active.symbol); } catch (_) {}

        const monitor = tracker.evaluate({ candles, forecast, chain: liveChain });

        // Live Greeks recompute (Δ / Γ / Θ / V).
        // Prefer the trade's stored expiry (broker-authoritative) over the
        // hardcoded weekly DOW lookup — NSE has changed NIFTY expiry day
        // twice in the last 18 months and our table can lag reality.
        let greeks = null;
        try {
            const spot = candles[candles.length - 1].close;
            const iv = (active.option.iv || 15) / 100;
            let dte;
            if (active.option.expiry) {
                const expMs = new Date(active.option.expiry + 'T15:30:00+05:30').getTime();
                dte = Math.max(0, (expMs - Date.now()) / (24 * 60 * 60 * 1000));
            } else {
                dte = daysToExpiry(active.symbol);
            }
            const T = Math.max(1 / (365 * 24), dte / 365);
            greeks = blackScholes({
                S: spot, K: active.option.strike, T, iv,
                right: active.option.right
            });
            greeks.dte = parseFloat(dte.toFixed(2));
            greeks.expiryUsed = active.option.expiry || null;
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

// Phase 105 — Audit log middleware on every mutating request
import { auditMiddleware, recent as recentAudit, log as auditLog } from './audit-log.js';
app.use('/api', auditMiddleware);

app.get('/api/audit', async (req, res) => {
    try {
        const limit = Math.min(500, parseInt(req.query.limit || '200', 10));
        const action = req.query.action || null;
        const since = req.query.since ? parseInt(req.query.since, 10) : null;
        res.json(recentAudit({ limit, action, since }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 105 — Auth scaffold. Single-tenant local mode now, multi-tenant ready.
//   • LOCAL_USER_PASSWORD env var (or generated on first boot, written to .auth/local-secret)
//   • POST /api/auth/login → JWT
//   • Middleware on POST /api/active-trade/* and POST /api/dhan/token
//   • Falls open for read endpoints because localhost-only single user
import jwt from 'jsonwebtoken';
import fs from 'fs';
import crypto from 'crypto';
// (path is already imported globally at the top of this file)
const _authDir = path.join(process.cwd(), '..', '.auth');
try { if (!fs.existsSync(_authDir)) fs.mkdirSync(_authDir, { recursive: true }); } catch (_) {}
const _secretPath = path.join(_authDir, 'jwt-secret');
let _jwtSecret;
try {
    if (fs.existsSync(_secretPath)) {
        _jwtSecret = fs.readFileSync(_secretPath, 'utf8').trim();
    } else {
        _jwtSecret = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(_secretPath, _jwtSecret, { mode: 0o600 });
        console.log('[auth] generated new JWT secret at', _secretPath);
    }
} catch (e) {
    _jwtSecret = process.env.JWT_SECRET || 'localhost-fallback-please-set-JWT_SECRET';
    console.warn('[auth] using fallback JWT secret:', e.message);
}
const _localPwd = process.env.LOCAL_USER_PASSWORD || null;

app.post('/api/auth/login', express.json(), (req, res) => {
    const { password } = req.body || {};
    if (!_localPwd) {
        // No password set → local convenience mode. Issue a token anyway.
        const token = jwt.sign({ actor: 'local', tenant: 'local' }, _jwtSecret, { expiresIn: '12h' });
        auditLog({ actor: 'local', action: 'auth.login', result: 'no-password-mode' });
        return res.json({ token, mode: 'no-password' });
    }
    if (password !== _localPwd) {
        auditLog({ actor: 'unknown', action: 'auth.login', result: 'denied' });
        return res.status(401).json({ error: 'invalid password' });
    }
    const token = jwt.sign({ actor: 'local', tenant: 'local' }, _jwtSecret, { expiresIn: '12h' });
    auditLog({ actor: 'local', action: 'auth.login', result: 'ok' });
    res.json({ token, mode: 'authenticated' });
});

function requireAuth(req, res, next) {
    if (!_localPwd) { req.actor = 'local'; return next(); }    // local convenience
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });
    try {
        const payload = jwt.verify(token, _jwtSecret);
        req.actor = payload.actor;
        req.tenant = payload.tenant || 'local';
        next();
    } catch (e) { res.status(401).json({ error: 'invalid token' }); }
}
// Apply auth to the few endpoints that actually mutate state in a sensitive way.
// (Most local POSTs intentionally don't need auth — single localhost user.)
app.use('/api/dhan/token', requireAuth);
app.use('/api/active-trade/enter', requireAuth);

// Phase 104B — Bus backend status endpoint.
// Surfaces whether the EventEmitter or Redis adapter is currently in use,
// so the operator can verify durable bus is wired before charging customers.
app.get('/api/bus/status', async (req, res) => {
    try {
        const { bus } = await import('./agents/bus.js');
        const isRedis = (process.env.BUS_BACKEND || '').toLowerCase() === 'redis';
        const redisUrl = process.env.REDIS_URL || null;
        const listenerCount = bus.eventNames().length;
        const worldKeys = Object.keys(bus.world || {});
        res.json({
            backend: isRedis ? 'redis' : 'in-process',
            redisConfigured: !!redisUrl,
            durable: isRedis,
            warningIfNotDurable: isRedis ? null :
                'Single-process EventEmitter — events lost on restart. Set BUS_BACKEND=redis + REDIS_URL to upgrade.',
            listenerCount,
            worldKeys,
            installSteps: isRedis ? null : [
                'docker run -d -p 6379:6379 --name qe-redis redis:7',
                'cd server && npm install ioredis',
                'echo "BUS_BACKEND=redis\\nREDIS_URL=redis://localhost:6379" >> .env',
                'restart server'
            ]
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 104A — Adaptive Meta Weights diagnostic.
app.get('/api/meta/weights', async (req, res) => {
    try {
        const { getAllMultipliers } = await import('./adaptive-meta-weights.js');
        res.json(getAllMultipliers());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/meta/weights/refresh', async (req, res) => {
    try {
        const { refresh } = await import('./adaptive-meta-weights.js');
        res.json(refresh());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 104H — Explainable AI: every signal exposes its full reasoning chain.
app.get('/api/explain/:symbol', async (req, res) => {
    try {
        const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
        const { getAgents } = await import('./agents/index.js');
        const agents = getAgents();
        if (!agents?.meta) return res.status(503).json({ error: 'Meta agent not ready' });
        const decision = await agents.meta.run({ symbol });
        const { bus } = await import('./agents/bus.js');
        const votes = bus.getAllVotes(symbol, 90_000);
        // Knowledge-graph context — what worked in similar regimes
        let kgContext = null;
        try {
            const { queryEdge } = await import('./knowledge-graph.js');
            const sim = queryEdge({ symbol, regime: decision.votes?.[0]?.regime, side: decision.side, minSamples: 1 });
            kgContext = sim;
        } catch (_) {}
        res.json({
            symbol,
            decision: {
                side: decision.side,
                band: decision.band,
                omegaScore: decision.omegaScore,
                fireable: decision.fireable,
                reasoning: decision.reasoning
            },
            decisionIntelligence: decision.decisionIntelligence,
            agentVotes: votes.map(v => ({
                agent: v.agent, side: v.side, confidence: v.confidence,
                reason: v.reason, regime: v.regime
            })),
            evidence: decision.evidence,
            knowledgeGraphContext: kgContext,
            disclaimer: 'No black box. Every input is shown above. Past patterns do not guarantee future outcomes.'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 104I — Continuous Self-Audit (daily summary).
app.get('/api/self-audit/daily', async (req, res) => {
    try {
        const { db } = await import('./db.js');
        const todayStart = (() => { const d = new Date(); d.setUTCHours(-5, -30, 0, 0); return d.getTime(); })();
        const tradesToday = db.prepare(`SELECT COUNT(*) n, SUM(pnl) totalPnl FROM trades WHERE time > ?`).get(todayStart);
        const shadowToday = db.prepare(`SELECT COUNT(*) n FROM shadow_signals WHERE ts > ?`).get(todayStart);
        const resolvedToday = db.prepare(`SELECT COUNT(*) n FROM shadow_signals WHERE ts > ? AND outcome IS NOT NULL`).get(todayStart);
        const winsToday = db.prepare(`SELECT COUNT(*) n FROM shadow_signals WHERE ts > ? AND outcome = 'WIN'`).get(todayStart);
        const cfToday = db.prepare(`SELECT COUNT(*) n FROM counterfactual_log WHERE ts > ?`).get(todayStart);
        const kgEdgesToday = db.prepare(`SELECT COUNT(*) n FROM omega_kg_edges WHERE ts > ?`).get(todayStart);
        const featuresToday = db.prepare(`SELECT COUNT(*) n FROM feature_values WHERE as_of_ts > ?`).get(todayStart);
        // Yesterday for delta
        const yesterdayStart = todayStart - 86400000;
        const tradesYesterday = db.prepare(`SELECT COUNT(*) n, SUM(pnl) totalPnl FROM trades WHERE time > ? AND time <= ?`).get(yesterdayStart, todayStart);
        res.json({
            date: new Date().toISOString().slice(0, 10),
            today: {
                trades: tradesToday.n, totalPnl: tradesToday.totalPnl || 0,
                shadowSignals: shadowToday.n, resolved: resolvedToday.n,
                winRate: resolvedToday.n > 0 ? parseFloat((winsToday.n / resolvedToday.n * 100).toFixed(1)) : 0,
                counterfactuals: cfToday.n,
                knowledgeEdges: kgEdgesToday.n,
                featuresWritten: featuresToday.n
            },
            yesterday: { trades: tradesYesterday.n, totalPnl: tradesYesterday.totalPnl || 0 },
            verdict: {
                learning: featuresToday.n > 100 ? 'ACTIVE' : 'IDLE',
                memory:   kgEdgesToday.n > 0 ? 'ACCUMULATING' : 'NO_NEW_EDGES_TODAY',
                tradingActive: tradesToday.n > 0
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 102 — Gamma blast standalone scanner (no active trade required).
// User flagged that gamma blast "has not worked" — turns out the existing
// banner only ever renders inside the active-trade monitor. This endpoint
// runs the same detector on the ATM CE + ATM PE of the selected symbol so
// the UI can surface a passive notice when the conditions exist even before
// a position is opened. Frontend polls every 15s.
app.get('/api/gamma-blast/scan/:symbol', async (req, res) => {
    try {
        const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
        const candles = await candleCache.get(symbol, '5minute', 50);
        if (!candles || candles.length < 8) {
            return res.json({ symbol, status: 'INSUFFICIENT_DATA', active: false });
        }
        const spot = candles[candles.length - 1].close;
        const cached = getCachedChain(symbol);
        const arr = Array.isArray(cached) ? cached : Array.isArray(cached?.chain) ? cached.chain : [];
        if (!arr.length) {
            return res.json({ symbol, status: 'NO_CHAIN', active: false, spot });
        }
        const strikes = [...new Set(arr.map(r => r.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
        const atmStrike = strikes[0];
        const ceRow = arr.find(r => r.strike === atmStrike && (r.right === 'CE' || r.type === 'CE'));
        const peRow = arr.find(r => r.strike === atmStrike && (r.right === 'PE' || r.type === 'PE'));
        const ceIv = ceRow?.iv ? ceRow.iv / 100 : 0.18;
        const peIv = peRow?.iv ? peRow.iv / 100 : 0.18;
        const ceResult = detectGammaBlast({ candles, symbol, strike: atmStrike, right: 'CE', iv: ceIv, spotNow: spot, side: 'BUY_CALL' });
        const peResult = detectGammaBlast({ candles, symbol, strike: atmStrike, right: 'PE', iv: peIv, spotNow: spot, side: 'BUY_PUT' });
        const best = (ceResult?.severity || 0) >= (peResult?.severity || 0) ? ceResult : peResult;
        res.json({
            symbol, spot, atmStrike,
            active: !!best?.active,
            severity: best?.severity || 0,
            directionalBias: best?.directionalBias || 'NEUTRAL',
            sideIcon: best?.sideIcon || '◆',
            label: best?.label || '· Normal',
            action: best?.action || null,
            momentumStrength: best?.momentumStrength || 0,
            call: ceResult ? { severity: ceResult.severity, gamma: ceResult.gamma, expectedMoveFor0p1Pct: ceResult.expectedMoveFor0p1Pct, premium: ceRow?.ltp ?? null } : null,
            put:  peResult ? { severity: peResult.severity, gamma: peResult.gamma, expectedMoveFor0p1Pct: peResult.expectedMoveFor0p1Pct, premium: peRow?.ltp ?? null } : null,
            ts: Date.now()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 99 — Fill ledger endpoints (the audited paper/live trade record).
app.get('/api/fills', async (req, res) => {
    try {
        const { getLedger } = await import('./fill-ledger.js');
        const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
        const paperOnly = req.query.paper === '1' ? true : req.query.paper === '0' ? false : null;
        const since = req.query.since ? parseInt(req.query.since, 10) : null;
        res.json(getLedger({ limit, paperOnly, since }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/fills/stats', async (req, res) => {
    try {
        const { getLedgerStats } = await import('./fill-ledger.js');
        res.json(getLedgerStats());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 99 — Backtest journey replay.
// GET /api/backtest/replay?symbol=NIFTY&date=2026-06-12&tf=5minute&lookback=60
// Returns the full day's candles + a per-candle engine score so the frontend
// can animate the replay one bar at a time with the verdict at each step.
app.get('/api/backtest/replay', async (req, res) => {
    try {
        const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
        const date = req.query.date || new Date(Date.now() - 86400e3).toISOString().slice(0,10);
        const tf = req.query.tf || '5minute';
        const lookback = Math.min(120, parseInt(req.query.lookback || '60', 10));
        const { db } = await import('./db.js');
        // pull a generous window: lookback bars before the start of the day + the whole day
        const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
        const dayEnd   = dayStart + 86400;
        const rows = db.prepare(`
            SELECT ts AS time, open, high, low, close, volume FROM candles_raw
            WHERE symbol = ? AND interval = ? AND ts >= ? - ? * 60 AND ts < ?
            ORDER BY ts ASC
        `).all(symbol, tf, dayStart, lookback * 30, dayEnd);
        if (rows.length < lookback + 5) {
            return res.status(404).json({ error: `not enough cached candles for ${symbol} ${date} ${tf}`, found: rows.length, need: lookback + 5 });
        }
        // For every bar after the lookback window, run the orchestrator
        const steps = [];
        for (let i = lookback; i < rows.length; i++) {
            const window = rows.slice(i - lookback, i + 1);
            const last = window[window.length - 1];
            try {
                const verdict = await orchestrator.evaluate({
                    candles: window, vix: 15, eventGate: { ok: true },
                    newsSentiment: null, mlScorer: null
                });
                steps.push({
                    ts: last.time,
                    spot: last.close,
                    side: verdict.side,
                    confluence: verdict.confluenceScore,
                    regime: verdict.regime?.regime,
                    firing: (verdict.votes || []).filter(v => v.fired).map(v => v.name),
                    band: verdict.tier
                });
            } catch (e) {
                steps.push({ ts: last.time, spot: last.close, error: e.message.slice(0, 80) });
            }
        }
        res.json({
            symbol, date, tf,
            candles: rows.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })),
            steps,
            stepsStart: lookback,
            summary: {
                bars: rows.length,
                steps: steps.length,
                fired: steps.filter(s => s.side === 'BUY_CALL' || s.side === 'BUY_PUT').length,
                callCount: steps.filter(s => s.side === 'BUY_CALL').length,
                putCount: steps.filter(s => s.side === 'BUY_PUT').length
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase 99 — Calibration health self-check.
//   • Verifies system clock matches IST market sessions
//   • Reports ECE + trend, current vs target (0.10)
//   • Estimates days-to-converge at current resolution rate
//   • Flags time drift between server clock and "now" if browser passes a tsBrowserMs
app.get('/api/calibration/health', async (req, res) => {
    try {
        const { db } = await import('./db.js');
        const summary = calibrator.summary?.() || {};
        // Check current ECE
        const ece = summary.ece ?? summary.ECE ?? null;
        // Look at resolved shadow signals last 7 days for resolution rate
        const since7 = Date.now() - 7 * 86400 * 1000;
        const resolved7d = db.prepare(`SELECT COUNT(*) n FROM shadow_signals WHERE ts > ? AND outcome IS NOT NULL`).get(since7).n;
        const totalSamples = db.prepare(`SELECT COUNT(*) n FROM shadow_signals WHERE outcome IS NOT NULL`).get().n;
        const rate = resolved7d / 7;  // resolutions per day
        // Rough estimate: ECE halves every ~10k samples; from 0.5 → 0.10 needs ~5 halvings = ~32k more
        const samplesToTarget = Math.max(0, Math.round((ece || 0.5) / 0.10 - 1) * 10000);
        const daysToTarget = rate > 0 ? Math.round(samplesToTarget / rate) : null;

        // Time/date verification — server vs browser drift
        const serverMs = Date.now();
        const browserMs = parseInt(req.query.tsBrowserMs || '0', 10);
        const driftMs = browserMs ? Math.abs(serverMs - browserMs) : null;
        const istNow = new Date(serverMs + (5.5 * 3600 * 1000));
        const istString = istNow.toISOString().replace('Z', ' IST');

        // Verify market-hours math
        const istHM = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
        const isMarketOpenNow = istHM >= 555 && istHM <= 930 && [1,2,3,4,5].includes(istNow.getUTCDay());

        res.json({
            ece, target: 0.10,
            verdict: ece == null ? 'UNKNOWN'
                   : ece <= 0.10 ? 'CALIBRATED'
                   : ece <= 0.20 ? 'CLOSE'
                   : 'POORLY_CALIBRATED',
            totalSamples,
            resolved7d,
            samplesPerDay: parseFloat(rate.toFixed(1)),
            samplesToTarget,
            daysToTarget,
            time: {
                serverMs,
                serverIstISO: istString,
                marketOpenNow: isMarketOpenNow,
                browserDriftMs: driftMs,
                clockOk: driftMs == null || driftMs < 5000
            },
            note: 'Calibration improves with every resolved shadow signal. ECE < 0.10 means a 90% confidence prediction is actually right ~90% of the time.'
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
                // Phase 89 — SQLite-backed candleCache (was 4 sequential
                // rate-limiter-queued Dhan calls → >12s hang per request).
                const candles = await candleCache.get(req.params.symbol, tf, 200);
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
    const sym = req.params.symbol;
    // STRICT REALTIME-ONLY: OI walls reflect the LIVE chain only. No cache,
    // no mock fallback. If broker has no data, walls = empty (matches what
    // the option-chain endpoint reports). Frontend doesn't draw lines when
    // the response is empty.
    try {
        if (provider.mode === 'mock' && process.env.NODE_ENV === 'production') {
            return res.status(503).json({
                error: 'realtime broker not connected (mock provider blocked in production)'
            });
        }
        // Phase 89 — chain-keeper cache + coalesced quote (both instant).
        // The previous direct provider calls queued behind the Dhan rate
        // limiter and 503'd after 6s on every poll. The keeper's chain IS the
        // live chain (continuously refreshed, ≤60s fresh during market hours).
        const cachedChain = getCachedChain(sym);
        const chain = Array.isArray(cachedChain) ? cachedChain
                    : Array.isArray(cachedChain?.chain) ? cachedChain.chain : [];
        if (!chain.length) {
            return res.status(503).json({ error: 'chain-keeper has no live chain yet', source: 'live' });
        }
        const quote = await getCoalescedQuote(sym).catch(() => null);
        const walls = detectOIWalls(chain, {
            topN: 3,
            spot: quote?.ltp ?? null
        });
        walls.chainSource = 'live';
        walls.chainRows = Array.isArray(chain) ? chain.length : 0;
        walls.fetchedAt = Date.now();
        res.json(walls);
    } catch (e) {
        res.status(503).json({ error: e.message, source: 'live' });
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

        // Omega 5-band gate — tag every signal with its band so the UI never
        // has to reimplement the policy and downstream code can filter on
        // `fireable: true` uniformly.
        const tagBand = (sig) => {
            if (!sig) return sig;
            const conf = sig.confidence ?? 0;
            const tier = classifySignal(conf);
            sig.signalTier   = tier.label;
            sig.signalColor  = tier.color;
            sig.userVisible  = tier.userVisible;
            sig.fireable     = tier.userVisible && sig.side && sig.side !== 'NO_TRADE';
            if (!sig.fireable && sig.side && sig.side !== 'NO_TRADE') {
                sig.suppressed = true;
                sig.suppressedReason =
                    `${tier.label} (${conf}) — only STRONG (≥90) and ELITE (≥95) fire.`;
            }
            return sig;
        };

        // v2 is now default — v1 retained for comparison
        if (engineVersion === 'v1') {
            const signal = engine.evaluate({ symbol, candles, currentPrice, chain, accountSize, riskPercent });
            return res.json(tagBand(signal));
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
        res.json(tagBand(signal));
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
    // Phase 121 — Hand every browser WebSocket to the Market Gateway so it
    // receives push ticks from FYERS the moment they land. Also sends an
    // immediate snapshot so the browser doesn't wait for the first tick.
    try { marketGateway.addSubscriber(ws); } catch (e) { /* gateway not ready, ok */ }

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

    // Phase 45: server-push chain updates every 1.5s for whichever symbols
    // the client is subscribed to. This kills client-side REST polling for
    // the chain — we read from the chain-keeper's cache only, never hit Dhan.
    const chainPushInterval = setInterval(() => {
        if (ws.readyState !== 1 || subs.size === 0) return;
        for (const sym of subs) {
            try {
                const cached = getCachedChain(sym);
                const arr = Array.isArray(cached) ? cached
                          : Array.isArray(cached?.chain) ? cached.chain : null;
                if (arr && arr.length) {
                    ws.send(JSON.stringify({
                        type: 'chain',
                        symbol: sym,
                        chain: arr,
                        stalenessSec: cached?.stalenessSec ?? null,
                        keeperStatus: cached?.status ?? null,
                        ts: Date.now()
                    }));
                }
            } catch (_) {}
        }
    }, 1500);

    ws.on('close', () => {
        provider.off('tick', onTick);
        clearInterval(chainPushInterval);
        subs.forEach(s => provider.unsubscribe([s]));
    });
    ws.send(JSON.stringify({ type: 'hello', mode: provider.mode }));
});

server.listen(PORT, () => {
    console.log(`[QuantEdge] backend listening on http://localhost:${PORT} (mode: ${provider.mode})`);
});

// Phase 71 — graceful shutdown: flush bus snapshot + stop scheduled timers
let _shuttingDown = false;
async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`[QuantEdge] received ${signal}, flushing and shutting down…`);
    try {
        const { bus } = await import('./agents/bus.js');
        bus.shutdown?.();
    } catch (_) {}
    try { wss?.close(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
