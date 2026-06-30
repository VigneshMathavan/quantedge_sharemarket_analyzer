// server/agents/index.js — Omega Agent Orchestrator
//
// Instantiates all 13 agents, registers them on the shared bus, and starts
// the reactive loops. The orchestrator is started from server/index.js after
// the broker provider and signal engine are ready.
//
// Constitution agent roster:
//    1. Market Regime
//    2. Technical Analysis
//    3. Options Intelligence
//    4. Order Flow
//    5. Risk
//    6. News Intelligence
//    7. Feature Engineering
//    8. Outcome Labeling
//    9. ML Prediction
//   10. Learning            (Bayesian)
//   11. Meta Decision       (final arbitrator)
//   12. Evaluation          (continuous self-audit)
//   13. Monitoring          (system health)

import { bus } from './bus.js';
import { db, sysLog, kvGet, kvSet } from '../db.js';
import { selfCalibrator } from './self-calibrator.js';

// Phase 107 — synthetic per-symbol notional sizing used to convert resolved
// shadow signals into representative pnl values for the Live Training Feed.
// Math: pnl ≈ direction × |move_pct/100| × spot × lot_size × delta_assumption.
// We assume delta=0.5 (ATM) — close enough for a "what would this trade have
// paid" estimate. Real paper-trade fills override this with actual pnl.
const SHADOW_LOT_SIZE = { NIFTY: 65, SENSEX: 20 };
const SHADOW_DELTA    = 0.5;
const SHADOW_MIN_CONF = 60;          // skip rejects + low-quality shadows

import { marketRegimeAgent }       from './market-regime-agent.js';
import { TechnicalAnalysisAgent }  from './technical-analysis-agent.js';
import { optionsIntelligenceAgent } from './options-intelligence-agent.js';
import { orderFlowAgent }          from './order-flow-agent.js';
import { riskAgent }               from './risk-agent.js';
import { newsIntelligenceAgent }   from './news-intelligence-agent.js';
import { featureEngineeringAgent } from './feature-engineering-agent.js';
import { OutcomeLabelingAgent }    from './outcome-labeling-agent.js';
import { mlPredictionAgent }       from './ml-prediction-agent.js';
import { learningAgent }           from './learning-agent.js';
import { metaDecisionAgent }       from './meta-decision-agent.js';
import { evaluationAgent }         from './evaluation-agent.js';
import { monitoringAgent }         from './monitoring-agent.js';
import { dataQualityAgent }        from './data-quality-agent.js';
import { devilsAdvocateAgent }     from './devils-advocate-agent.js';
import { portfolioAllocatorAgent } from './portfolio-allocator-agent.js';
import { selfAuditAgent }          from './self-audit-agent.js';
import { driftDetectionAgent }     from './drift-detection-agent.js';
import { marketMemoryAgent }       from './market-memory-agent.js';
import { opportunityCostAgent }    from './opportunity-cost-agent.js';
// Phase 48-72 — true-agentic additions
import { llmExplainerAgent }       from './llm-explainer-agent.js';
import { plannerAgent }            from './planner-agent.js';
import { goalManagerAgent }        from './goal-manager-agent.js';
import { alertingAgent }           from './alerting-agent.js';
// Phase 74-79 true-agentic additions
import { codeModifierAgent }       from './code-modifier-agent.js';
import { hypothesisAgent }         from './hypothesis-agent.js';
import { debateCoordinatorAgent }  from './debate-coordinator-agent.js';
import { worldModelAgent }         from './world-model-agent.js';
import { memoryConsolidatorAgent } from './memory-consolidator-agent.js';
import { metaMetaAgent }           from './meta-meta-agent.js';
import { smartGoalAgent }          from './smart-goal-agent.js';
import { journalAgent }            from './journal-agent.js';
import { integrityWatcherAgent }   from './integrity-watcher-agent.js';

// Phase 1 — wire decision audit trail into production
import '../audit-trail.js';

let _agents = null;

export function startAgents({ provider, engine, engineV2 }) {
    if (_agents) return _agents;

    // TechnicalAnalysisAgent needs the engine injected — instantiate it here.
    // OutcomeLabelingAgent is purely outcome-driven, instantiate fresh.
    const tech       = new TechnicalAnalysisAgent({ engine: engineV2 || engine });
    const outcomeLbl = new OutcomeLabelingAgent();

    _agents = {
        marketRegime:    marketRegimeAgent,
        technical:       tech,
        options:         optionsIntelligenceAgent,
        orderFlow:       orderFlowAgent,
        risk:            riskAgent,
        news:            newsIntelligenceAgent,
        features:        featureEngineeringAgent,
        outcomeLabeling: outcomeLbl,
        mlPrediction:    mlPredictionAgent,
        learning:        learningAgent,
        meta:            metaDecisionAgent,
        evaluation:      evaluationAgent,
        monitoring:      monitoringAgent,
        // Phase 24-33 additions + 83 integrity watcher
        integrityWatcher:   integrityWatcherAgent,
        dataQuality:        dataQualityAgent,
        devilsAdvocate:     devilsAdvocateAgent,
        portfolioAllocator: portfolioAllocatorAgent,
        selfAudit:          selfAuditAgent,
        // Phase 42-44 — persona-mandated agentized ML modules
        driftDetection:     driftDetectionAgent,
        marketMemory:       marketMemoryAgent,
        opportunityCost:    opportunityCostAgent,
        // Phase 48-72 additions
        llmExplainer:       llmExplainerAgent,
        planner:            plannerAgent,
        goalManager:        goalManagerAgent,
        alerting:           alertingAgent
    };

    // Start them all
    for (const a of Object.values(_agents)) {
        try { a.start?.(); }
        catch (e) { sysLog('ERROR', 'agents', `${a.name} start: ${e.message}`); }
    }

    // ── Shared learning loop ──────────────────────────────────────────────
    // Every resolved shadow signal feeds the LearningAgent (Beta posterior).
    // This is the heart of the "learn from everything" mandate — score-1
    // setups update the prior just like score-99 setups.
    bus.on('shadow:resolved', (payload) => {
        try {
            learningAgent.update({
                regime: payload.regime,
                session: payload.session,
                side: payload.side,
                omegaScore: payload.confidence,
                outcome: payload.outcome === 'WIN' ? 'TP1' :
                         payload.outcome === 'LOSS' ? 'SL' : 'NO_FT',
                rrr: payload.rrr ?? null
            });
        } catch (e) { sysLog('WARN', 'agents:learning', e.message); }

        // Phase 105 — Shadow → Knowledge Graph bridge.
        // The KG used to only ingest real closed trades, which is why it
        // stayed at 0 rows. With 200k+ resolved shadow signals available we
        // route every resolved shadow as a "shadow edge" so the KG has real
        // regime/side/outcome memory without needing live capital at risk.
        try {
            import('../knowledge-graph.js').then(({ writeEdge }) => {
                writeEdge({
                    ts: payload.ts || Date.now(),
                    symbol: payload.symbol,
                    side: payload.side,
                    regime: payload.regime,
                    sessionPhase: payload.session,
                    strategyIds: payload.firingStrategies || [],
                    entryPremium: null,
                    exitPremium: null,
                    pnl: null,
                    pnlPct: payload.movePct ?? null,
                    result: payload.outcome,        // WIN / LOSS / FLAT
                    exitReason: 'SHADOW_RESOLVED',
                    confidence: payload.confidence,
                    source: 'shadow'                // tag so it's distinguishable from live trades
                });
            }).catch(() => {});
        } catch (e) { sysLog('WARN', 'agents:kg-bridge', e.message); }

        // Phase 107 — Shadow → Live Training Feed bridge.
        // The /api/learner/feed view was frozen on 2026-05-29 because the
        // pipeline never wrote to `trades` outside of paper-trade fills. With
        // 200k+ resolved shadows available, gate them on quality and persist
        // a `source='live_shadow'` row + matching signal_journal entry so the
        // feed shows what the engine is actually learning, in real time.
        try {
            const sym = payload.symbol;
            const side = payload.side;
            const conf = payload.confidence || 0;
            if (
                !SHADOW_LOT_SIZE[sym] ||
                !side || side === 'NO_TRADE' ||
                conf < SHADOW_MIN_CONF ||
                payload.outcome === 'FLAT'
            ) return;

            const row = db.prepare(`
                SELECT spot, factor_scores_json, regime, band
                  FROM shadow_signals WHERE id = ?
            `).get(payload.id);
            if (!row || !row.spot) return;

            const lotSize  = SHADOW_LOT_SIZE[sym];
            const movePct  = payload.movePct ?? 0;
            const dirSign  = payload.outcome === 'WIN' ? 1 : -1;
            const pnl = Math.round(dirSign * Math.abs(movePct / 100) * row.spot * lotSize * SHADOW_DELTA);
            const tsMs = payload.ts || Date.now();
            const factorScoresJson = row.factor_scores_json || '{}';

            const insertTx = db.transaction(() => {
                db.prepare(`
                    INSERT INTO trades (id, time, exit_time, symbol, side, pnl, result,
                                        exit_reason, tier, confidence, regime, source, full_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live_shadow', ?)
                `).run(
                    `sh_${payload.id}`, tsMs, tsMs + 60_000, sym, side, pnl,
                    payload.outcome === 'WIN' ? 'WIN' : 'LOSS',
                    'SHADOW_RESOLVED', row.band || null,
                    conf, row.regime || null,
                    JSON.stringify({ shadowId: payload.id, movePct, source: 'shadow' })
                );
                db.prepare(`
                    INSERT INTO signal_journal (ts, symbol, side, tier, confluence_score,
                                                regime, spot, full_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    tsMs, sym, side, row.band || null, conf,
                    row.regime || null, row.spot,
                    JSON.stringify({
                        actionable: { factorScores: JSON.parse(factorScoresJson) },
                        source: 'shadow_bridge'
                    })
                );
            });
            insertTx();
        } catch (e) { sysLog('WARN', 'agents:shadow-trade-bridge', e.message); }
    });

    sysLog('INFO', 'agents', `${Object.keys(_agents).length} agents started`);
    return _agents;
}

export function getAgents() { return _agents; }

export function getAgentsHealth() {
    if (!_agents) return { running: false, agents: [] };
    return {
        running: true,
        count: Object.keys(_agents).length,
        agents: Object.values(_agents).map(a => a.health?.() || { agent: a.name, running: false })
    };
}

export function getAgentStates() {
    return bus.getAgentStates();
}

export function getMetaDecisions() {
    return _agents?.meta?._state?.lastDecisions || {};
}

export function getAgentCalibrations() {
    return selfCalibrator.getSnapshot();
}
