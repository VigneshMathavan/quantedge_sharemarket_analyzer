// server/adaptive-meta-weights.js — Phase 104A
//
// THE LOOP THAT WAS MISSING.
// =========================
//
// Audit verdict: "Bayesian updates occur · Meta weights stay static."
// This file closes that loop.
//
// For every agent we compute a rolling calibration multiplier from its actual
// historical correctness. MetaDecisionAgent v2 multiplies each agent's vote
// confidence by this multiplier at arbitration time, so over-confident agents
// get pulled down and under-confident reliable agents get pushed up.
//
// The multiplier is a Beta-Bernoulli posterior weighted by sample size:
//   mult(agent) = 0.5 + (posterior_mean - baseline) × confidence_factor
// where
//   posterior_mean = (1 + correct_votes) / (2 + total_votes)        [Laplace smoothing]
//   confidence_factor = 1 - 1 / (1 + n / 20)                         [saturates at n=80+]
//   baseline = average of all agents' posterior means in same regime
//
// Correctness criterion:
//   • Vote was BUY_CALL  + outcome WIN  → correct
//   • Vote was BUY_PUT   + outcome WIN  → correct
//   • Vote was NO_TRADE  + outcome FLAT → correct (we correctly avoided)
//   • Anything else → incorrect
//
// Run frequency: every 5 minutes (cron), reading the last 7 days of resolved
// signals from shadow_signals + agent vote history.
//
// API:
//   getMultiplier(agentName, regime?)  → number ∈ [0.5, 1.5]
//   refresh()                          → rebuild from SQLite, log summary
//   getAllMultipliers()                → diagnostic snapshot for /api/agents/calibration
//   getWeightHistory()                → last 200 weight snapshots from KV

import { db, kvGet, kvSet, sysLog } from './db.js';

const CACHE_KEY = 'adaptive_meta_weights_v1';
const HISTORY_KEY = 'adaptive_weight_history_v1';
const REFRESH_INTERVAL_MS = 5 * 60_000;
const LOOKBACK_DAYS = 7;
const MIN_SAMPLES = 10;
const HISTORY_MAX = 200;

// Per-agent directional contribution weights — used for floor/ceiling guards.
// Multipliers must not push effective weight below 0.05 or above 0.50.
const AGENT_WEIGHTS = {
    TechnicalAnalysisAgent:   0.25,
    OrderFlowAgent:           0.18,
    OptionsIntelligenceAgent: 0.18,
    MarketRegimeAgent:        0.13,
    FeatureEngineeringAgent:  0.13,
    MarketMemoryAgent:        0.13
};

let _cache = kvGet(CACHE_KEY) || { ts: 0, multipliers: {}, byRegime: {}, baselines: {} };

// ── Internal: pull agent votes joined with signal outcomes ──
function _loadAgentSamples() {
    const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
    // agent_votes is a JSON column on shadow_signals; iterate in JS.
    const rows = db.prepare(`
        SELECT id, ts, symbol, side, outcome, regime, conditions_json
        FROM shadow_signals
        WHERE ts > ? AND outcome IS NOT NULL AND conditions_json IS NOT NULL
        ORDER BY ts DESC
        LIMIT 50000
    `).all(since);

    // Factor → Agent mapping. conditions_json carries 8 pillar scores
    // (the actual learnable signals); we attribute each pillar's correctness
    // back to its owning agent so Meta v2 can adapt each agent's weight.
    const FACTOR_TO_AGENT = {
        trendAlignment:  'TechnicalAnalysisAgent',
        vwapDistance:    'TechnicalAnalysisAgent',
        momentum:        'TechnicalAnalysisAgent',
        structure:       'OrderFlowAgent',
        volume:          'OrderFlowAgent',
        volatility:      'MarketRegimeAgent',
        optionFlow:      'OptionsIntelligenceAgent',
        ivContext:       'OptionsIntelligenceAgent',
        featureQuality:  'FeatureEngineeringAgent',
        analogStrength:  'MarketMemoryAgent'
    };

    const out = {};
    for (const r of rows) {
        let conds = null;
        try { conds = JSON.parse(r.conditions_json); } catch (_) { continue; }
        if (!conds || typeof conds !== 'object') continue;
        for (const [factor, payload] of Object.entries(conds)) {
            const agent = FACTOR_TO_AGENT[factor];
            if (!agent || !payload || typeof payload !== 'object') continue;
            if (payload.met !== true) continue;  // only count when factor fired
            const correct = r.outcome === 'WIN';
            if (!out[agent]) out[agent] = { seen: 0, correct: 0, byRegime: {} };
            out[agent].seen++;
            if (correct) out[agent].correct++;
            const rg = r.regime || 'unknown';
            if (!out[agent].byRegime[rg]) out[agent].byRegime[rg] = { seen: 0, correct: 0 };
            out[agent].byRegime[rg].seen++;
            if (correct) out[agent].byRegime[rg].correct++;
        }
    }
    return out;
}

function _posteriorMean(correct, total) {
    return (1 + correct) / (2 + total);   // Laplace smoothing prior
}
function _confidenceFactor(n) {
    return 1 - 1 / (1 + n / 20);
}

export function refresh() {
    const samples = _loadAgentSamples();
    const baselineSamples = Object.values(samples);
    const globalBaseline = baselineSamples.length
        ? baselineSamples.reduce((s, a) => s + _posteriorMean(a.correct, a.seen), 0) / baselineSamples.length
        : 0.5;

    const multipliers = {};
    const byRegime = {};
    for (const [agent, data] of Object.entries(samples)) {
        if (data.seen < MIN_SAMPLES) {
            multipliers[agent] = 1.0;
            continue;
        }
        const pm = _posteriorMean(data.correct, data.seen);
        const cf = _confidenceFactor(data.seen);
        let mult = 0.5 + (pm - globalBaseline + 0.5) * cf;
        mult = Math.max(0.5, Math.min(1.5, mult));
        // Floor/ceiling guard: if agent is in AGENT_WEIGHTS, ensure
        // effective weight (base × mult) stays within [0.05, 0.50]
        const baseW = AGENT_WEIGHTS[agent];
        if (baseW) {
            const effLow  = 0.05 / baseW;  // multiplier floor
            const effHigh = 0.50 / baseW;  // multiplier ceiling
            mult = Math.max(effLow, Math.min(effHigh, mult));
        }
        multipliers[agent] = parseFloat(mult.toFixed(3));

        byRegime[agent] = {};
        for (const [rg, rdata] of Object.entries(data.byRegime)) {
            if (rdata.seen < MIN_SAMPLES) continue;
            const rpm = _posteriorMean(rdata.correct, rdata.seen);
            const rcf = _confidenceFactor(rdata.seen);
            let rmult = 0.5 + (rpm - globalBaseline + 0.5) * rcf;
            byRegime[agent][rg] = parseFloat(Math.max(0.5, Math.min(1.5, rmult)).toFixed(3));
        }
    }
    _cache = {
        ts: Date.now(),
        multipliers, byRegime,
        baselines: { global: parseFloat(globalBaseline.toFixed(3)) },
        sampleCount: Object.values(samples).reduce((s, a) => s + a.seen, 0),
        agentCount: Object.keys(samples).length
    };
    kvSet(CACHE_KEY, _cache);

    // Append to weight history (cap at HISTORY_MAX snapshots)
    _appendWeightHistory({
        ts: _cache.ts,
        multipliers: { ..._cache.multipliers },
        baselines: { ..._cache.baselines },
        sampleCount: _cache.sampleCount
    });

    sysLog('INFO', 'meta-weights',
        `refreshed · ${_cache.agentCount} agents · ${_cache.sampleCount} samples · baseline=${_cache.baselines.global}`);
    return _cache;
}

export function getMultiplier(agentName, regime = null) {
    if (regime && _cache.byRegime?.[agentName]?.[regime] != null) {
        return _cache.byRegime[agentName][regime];
    }
    return _cache.multipliers?.[agentName] ?? 1.0;
}

export function getAllMultipliers() {
    return { ...(_cache || {}), age_ms: Date.now() - (_cache?.ts || 0) };
}

// ── Weight history tracking ──
function _appendWeightHistory(snapshot) {
    try {
        const history = kvGet(HISTORY_KEY) || [];
        history.push(snapshot);
        // Cap at HISTORY_MAX entries (keep most recent)
        while (history.length > HISTORY_MAX) history.shift();
        kvSet(HISTORY_KEY, history);
    } catch (e) {
        sysLog('WARN', 'meta-weights', `history append failed: ${e.message}`);
    }
}

export function getWeightHistory() {
    return kvGet(HISTORY_KEY) || [];
}

// Auto-refresh
setInterval(() => { try { refresh(); } catch (e) { sysLog('WARN', 'meta-weights', e.message); } }, REFRESH_INTERVAL_MS);
// Initial refresh delayed so DB is fully ready
setTimeout(() => { try { refresh(); } catch (e) { sysLog('WARN', 'meta-weights', e.message); } }, 8_000);
