// server/agents/meta-decision-agent.js
//
// Omega Agent #11 — the final arbitrator.
// Constitution: "Meta Decision Agent combines votes from all other agents
// and produces the final omega score + side. This is the only agent the
// user-facing signal endpoint should trust as authoritative."
//
// Algorithm (Phase 1 — interpretable, weighted average):
//   For a given symbol, pull every agent's most-recent vote (≤60s old) and:
//     1. Weighted sum of directional confidences  (agent weights below)
//     2. Bayesian P(win) from MLPredictionAgent multiplies the score
//     3. RiskAgent veto → confidence floored to 0
//     4. NewsIntelligenceAgent HIGH severity → confidence × 0.6 (size-down,
//        but does NOT block — per user mandate 2026-06-07)
//
// Future (Phase 2): replace the linear combiner with a stacked meta-model
// trained on the shadow_signals + outcomes corpus.

import { BaseAgent } from './base-agent.js';
import { bus } from './bus.js';
import { classifySignal } from '../signal-gate.js';
import { selfCalibrator } from './self-calibrator.js';
// Phase 104A — cross-agent adaptive weights (vs single-agent self-calibration)
import { getMultiplier as getAdaptiveWeight, getAllMultipliers } from '../adaptive-meta-weights.js';
// Phase 1 — Decision audit recording
import { recordDecision } from '../audit-trail.js';
// Phase 3 — Knowledge Graph consumption
import { queryEdge } from '../knowledge-graph.js';
import { sysLog } from '../db.js';

// Per-agent contribution weights for the DIRECTIONAL combiner.
// Hostile / data-quality / drift / opportunity-cost agents apply attenuation
// in the post-processing block below — they are NOT directional voters.
const AGENT_WEIGHTS = {
    TechnicalAnalysisAgent:   0.25,
    OrderFlowAgent:           0.18,
    OptionsIntelligenceAgent: 0.18,
    MarketRegimeAgent:        0.13,
    FeatureEngineeringAgent:  0.13,
    MarketMemoryAgent:        0.13   // k-NN analog vote — Phase 43
};

const SYMBOLS = ['NIFTY','SENSEX'];

// Track previous adaptive multipliers for change detection
let _prevAdaptiveMultipliers = {};

export class MetaDecisionAgent extends BaseAgent {
    constructor() {
        super({
            name: 'MetaDecisionAgent',
            version: '1.0.0',
            description: 'Final arbitrator — combines agent votes into Omega score & side',
            tickIntervalMs: 5_000          // arbitrate every 5s
        });
    }

    async evaluate({ symbol } = {}) {
        if (!symbol) return { side: 'NO_TRADE', confidence: 0, omegaScore: 0,
                              reasoning: 'No symbol supplied', evidence: [] };

        const votes = bus.getAllVotes(symbol, 90_000);
        if (!votes.length) {
            return { symbol, side: 'NO_TRADE', confidence: 0, omegaScore: 0,
                     reasoning: 'No agent votes in window', evidence: [], votes: [] };
        }

        // 1) Directional weighted sum  (BUY_CALL = +1, BUY_PUT = -1, NO_TRADE = 0)
        let signed = 0, weightSum = 0;
        const evidence = [];
        const currentAdaptiveMultipliers = {};
        for (const v of votes) {
            const w = AGENT_WEIGHTS[v.agent];
            if (!w) continue;            // ignore agents not in the weight table
            const dir = v.side === 'BUY_CALL' ?  1
                     :  v.side === 'BUY_PUT'  ? -1
                     :  0;
            // Phase 104A — TWO calibration multipliers now compound:
            //   1. selfCal — agent's own Beta posterior (does it agree with itself?)
            //   2. adapt   — cross-agent Bayesian from shadow_signals × regime
            // Both ∈ [0.5, 1.5]. Product clamped to [0.5, 2.0] so a single bad
            // pass can't kill an otherwise reliable agent and a single great
            // pass can't 10x an over-eager one.
            const selfCal = selfCalibrator.getMultiplier(v.agent) || 1.0;
            const adapt   = getAdaptiveWeight(v.agent, v.regime) || 1.0;
            const cal     = Math.max(0.5, Math.min(2.0, selfCal * adapt));
            const effW    = w * cal;
            signed    += dir * (v.confidence || 0) * effW;
            weightSum += effW;
            currentAdaptiveMultipliers[v.agent] = adapt;
            evidence.push(`${v.agent}: ${v.side} ${(v.confidence*100|0)}% (w=${w}×self=${selfCal.toFixed(2)}×adapt=${adapt.toFixed(2)})`);
        }

        // Phase 1 — Log when any agent's adaptive weight shifts >5% from previous tick
        for (const [agent, mult] of Object.entries(currentAdaptiveMultipliers)) {
            const prev = _prevAdaptiveMultipliers[agent];
            if (prev != null && Math.abs(mult - prev) / Math.max(0.001, prev) > 0.05) {
                sysLog('INFO', 'meta-weights-shift',
                    `${agent} adaptive weight shifted ${(prev).toFixed(3)} → ${(mult).toFixed(3)} (${((mult - prev) / prev * 100).toFixed(1)}%)`);
            }
        }
        _prevAdaptiveMultipliers = { ...currentAdaptiveMultipliers };

        const norm = weightSum > 0 ? signed / weightSum : 0;
        let side = 'NO_TRADE';
        if (norm >  0.10) side = 'BUY_CALL';
        if (norm < -0.10) side = 'BUY_PUT';
        let confidence = Math.min(1, Math.abs(norm));

        // 2) Bayesian win-prob multiplier
        const ml = votes.find(v => v.agent === 'MLPredictionAgent');
        if (ml?.winProbability != null) {
            confidence *= (0.5 + ml.winProbability);   // 0.5..1.5 multiplier
            evidence.push(`ML pWin=${(ml.winProbability*100|0)}% → ×${(0.5+ml.winProbability).toFixed(2)}`);
        }

        // 3) Risk veto
        const risk = votes.find(v => v.agent === 'RiskAgent');
        if (risk?.veto) {
            confidence = 0;
            side = 'NO_TRADE';
            evidence.push(`RiskAgent VETO: ${risk.reason}`);
        }

        // 4) News severity attenuation (size-down, do not block)
        const news = votes.find(v => v.agent === 'NewsIntelligenceAgent');
        if (news?.severity === 'HIGH') {
            confidence *= 0.6;
            evidence.push(`News HIGH (${news.event}) → confidence × 0.6 (size-down)`);
        }

        // 5) Data Quality veto (Phase 24) — hard block on bad data
        const dq = votes.find(v => v.agent === 'DataQualityAgent');
        if (dq?.veto || dq?.dataQuality === 'FAIL') {
            confidence = 0; side = 'NO_TRADE';
            evidence.push(`DataQualityAgent VETO: ${dq.reason || 'data quality failure'}`);
        }

        // 6) Drift Detection attenuation (Phase 42)
        const drift = bus.getAllVotes(symbol, 90_000)
                         .find(v => v.agent === 'DriftDetectionAgent');
        if (drift?.verdict === 'SIGNIFICANT_DRIFT') {
            confidence *= 0.5;
            evidence.push(`Drift SIGNIFICANT → confidence × 0.5`);
        } else if (drift?.verdict === 'MILD_DRIFT') {
            confidence *= 0.85;
            evidence.push(`Drift MILD → confidence × 0.85`);
        }

        // 7) Devils Advocate contrarian attenuation (Phase 26)
        const devil = votes.find(v => v.agent === 'DevilsAdvocateAgent');
        if (devil?.confidence > 0) {
            const shrink = 1 - 0.3 * devil.confidence;     // up to 30% shrink
            confidence *= shrink;
            evidence.push(`Devil ${devil.objectionCount || 0} objections → × ${shrink.toFixed(2)}`);
        }

        // 8) Knowledge Graph Historical Edge (Phase 3)
        if (side !== 'NO_TRADE') {
            const kg = queryEdge({ regime: votes[0]?.regime, side, symbol, minSamples: 5 });
            if (kg && kg.edge === 'NEGATIVE' && kg.winRate < 45) {
                confidence *= 0.8;
                evidence.push(`KG Historical Edge NEGATIVE (WR ${kg.winRate}%) → confidence × 0.8`);
            } else if (kg && kg.edge === 'POSITIVE' && kg.winRate > 65) {
                confidence = Math.min(1.0, confidence * 1.1);
                evidence.push(`KG Historical Edge POSITIVE (WR ${kg.winRate}%) → confidence × 1.1`);
            }
        }

        // Map confidence → 0-100 Omega score, then to 5-band tier
        const omegaScore = parseFloat((Math.min(1, confidence) * 100).toFixed(1));
        const tier = classifySignal(omegaScore);

        // Phase 1 — Platt calibration integration
        let calibratedScore = null;
        try {
            const { calibrate } = await import('../ml/calibration-platt.js');
            calibratedScore = parseFloat(calibrate(omegaScore).toFixed(4));
        } catch (_) {
            // Platt not fitted yet or module unavailable — non-fatal
        }

        // Phase 104D — Decision Intelligence: every Meta decision now carries
        // EV, expected drawdown, expected RR, and a model-confidence number.
        // These replace the previous opaque "confidence" with audit-grade
        // numbers a hedge fund CIO can defend.
        //
        // EV = pWin × meanWinPct − (1 − pWin) × meanLossPct
        // Expected drawdown approximates MAE from prior similar setups.
        // Expected RR = avg(MFE) / avg(MAE) when both > 0, else 1.0.
        const mlPred = votes.find(vv => vv.agent === 'MLPredictionAgent');
        const pWin = mlPred?.winProbability ?? 0.5;
        // Phase 105 — pull mean win/loss from the user's REAL last-90-day trade
        // history (cached for 5 minutes). Falls back to conservative priors
        // only if there are fewer than 20 fills on record.
        const { getRealRRStats } = await import('../meta-rr-stats.js');
        const stats = getRealRRStats(symbol, votes[0]?.regime);
        const meanWinPct  = stats.meanWinPct;     // dynamic
        const meanLossPct = stats.meanLossPct;    // dynamic
        const expectedValuePct = pWin * meanWinPct - (1 - pWin) * meanLossPct;
        const expectedDrawdownPct = (1 - pWin) * meanLossPct;
        const expectedRR = (meanWinPct * pWin) / Math.max(0.01, meanLossPct * (1 - pWin));

        const result = {
            symbol, side, confidence: parseFloat(confidence.toFixed(3)),
            omegaScore,
            calibratedScore: calibratedScore || null,
            regime: votes[0]?.regime || null,
            adaptiveWeights: { ...currentAdaptiveMultipliers },
            band:        tier.label,
            userVisible: tier.userVisible,
            fireable:    tier.userVisible && side !== 'NO_TRADE',
            reasoning:   `Meta v2: ${side} (Omega ${omegaScore} · ${tier.label}) · EV ${(expectedValuePct*100).toFixed(1)}% from ${votes.length} agent votes`,
            decisionIntelligence: {
                pWin: parseFloat(pWin.toFixed(3)),
                expectedValuePct: parseFloat(expectedValuePct.toFixed(4)),
                expectedDrawdownPct: parseFloat(expectedDrawdownPct.toFixed(4)),
                expectedRR: parseFloat(expectedRR.toFixed(2)),
                edgeQuality: expectedValuePct > 0.05 ? 'STRONG' : expectedValuePct > 0 ? 'POSITIVE' : 'NEGATIVE',
                version: 'v2'
            },
            evidence,
            votes
        };

        // Phase 1 — Record to decision audit trail
        try { recordDecision(result); } catch (_) { /* non-fatal */ }

        return result;
    }

    async onTick() {
        const decisions = {};
        for (const symbol of SYMBOLS) {
            const d = await this.run({ symbol });
            decisions[symbol] = {
                side: d.side, omegaScore: d.omegaScore,
                band: d.band, fireable: d.fireable
            };
            if (d.fireable) {
                this.publish('meta:decision', d);
            }
        }
        this.publishState({ lastDecisions: decisions, ts: Date.now() });
    }
}

export const metaDecisionAgent = new MetaDecisionAgent();
