// server/strategies/base.js — Strategy interface + orchestrator.
//
// Every strategy is a plain object with this shape:
// {
//   id: 'orb',                       // unique ID
//   name: 'Opening Range Breakout',  // human label
//   marketBias: 'trending|chop|any', // when it's relevant
//   weight: 15,                      // confluence score contribution if it fires
//
//   detect({ candles, indicators, timeIST, vix }) → {
//     fired: boolean,
//     side: 'BUY_CALL' | 'BUY_PUT' | null,
//     reason: string,                // short explanation
//     metrics: { ... }               // strategy-specific debug info
//   }
// }
//
// The orchestrator runs every strategy, collects votes, then combines them
// via the confluence scorer below.

import { ema, rsi, atr, vwap, adx, classifyRegime, sessionPhase } from '../signal2.js';
import { adaptiveWeights } from './adaptive-weights.js';

// ============================================================
//  Indicator pre-computation (shared across strategies)
// ============================================================
export function computeIndicators(candles) {
    if (candles.length < 30) return null;
    const closes = candles.map(c => c.close);
    return {
        closes,
        ema9: ema(closes, 9),
        ema20: ema(closes, 20),
        ema50: ema(closes, 50),
        rsi14: rsi(closes, 14),
        atr14: atr(candles, 14),
        vwap: vwap(candles),
        adx14: adx(candles, 14),
        regime: classifyRegime(candles)
    };
}

// IST time helper — converts unix sec → { h, m } in IST
export function istClock(unixSec) {
    const istMs = unixSec * 1000 + (5 * 60 + 30) * 60 * 1000;
    const d = new Date(istMs);
    return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

// ============================================================
//  Orchestrator
// ============================================================
export class StrategyOrchestrator {
    constructor(strategies = []) {
        this.strategies = strategies;
    }

    register(strategy) {
        this.strategies.push(strategy);
        return this;
    }

    // Run every strategy and gather votes
    async evaluate({ candles, vix = 15, eventGate = null, newsSentiment = null, mlScorer = null }) {
        if (candles.length < 50) return { side: 'NO_TRADE', reason: 'insufficient candles', votes: [], confluenceScore: 0 };

        const indicators = computeIndicators(candles);
        if (!indicators) return { side: 'NO_TRADE', reason: 'indicator computation failed', votes: [], confluenceScore: 0 };

        const last = candles[candles.length - 1];
        const timeIST = istClock(last.time);
        const session = sessionPhase(Date.now());

        const ctx = { candles, indicators, timeIST, vix, last };

        const votes = [];
        for (const s of this.strategies) {
            try {
                const v = await s.detect(ctx);
                // Adaptive weight from past trade outcomes
                const adaptiveMult = adaptiveWeights.getMultiplier(s.id);
                const effectiveWeight = s.weight * adaptiveMult;
                votes.push({
                    id: s.id,
                    name: s.name,
                    baseWeight: s.weight,
                    adaptiveMult: parseFloat(adaptiveMult.toFixed(3)),
                    weight: parseFloat(effectiveWeight.toFixed(2)),
                    fired: !!v.fired,
                    side: v.side || null,
                    reason: v.reason || '',
                    metrics: v.metrics || {}
                });
            } catch (e) {
                votes.push({ id: s.id, name: s.name, weight: 0, fired: false, side: null, reason: 'error: ' + e.message });
            }
        }

        return await this.confluenceScore(votes, indicators, last, eventGate, session, newsSentiment, mlScorer);
    }

    // Combine votes into a final signal
    async confluenceScore(votes, indicators, last, eventGate, session, newsSentiment, mlScorer) {
        const callVotes = votes.filter(v => v.fired && v.side === 'BUY_CALL');
        const putVotes = votes.filter(v => v.fired && v.side === 'BUY_PUT');

        let callScore = callVotes.reduce((a, v) => a + v.weight, 0);
        let putScore = putVotes.reduce((a, v) => a + v.weight, 0);

        // News sentiment nudge — small boost to aligned direction
        let newsAdjustment = { call: 0, put: 0, reason: 'no news' };
        if (newsSentiment) {
            const sentScore = Math.abs(newsSentiment.score || 0);
            const cappedBoost = Math.min(8, sentScore * 0.6);  // max +8 from news
            if (newsSentiment.sentiment === 'bullish') {
                callScore += cappedBoost; newsAdjustment = { call: cappedBoost, put: 0, reason: `bullish news (+${cappedBoost.toFixed(1)})` };
            } else if (newsSentiment.sentiment === 'bearish') {
                putScore += cappedBoost; newsAdjustment = { call: 0, put: cappedBoost, reason: `bearish news (+${cappedBoost.toFixed(1)})` };
            }
        }

        let side = 'NO_TRADE';
        let confluenceScore = 0;
        let dominantVotes = [];

        // God Mode: ANY directional lean fires (was 18). Approval engine
        // + path forecaster judge quality downstream — we don't gate here.
        const minScore = 1;
        if (callScore > putScore && callScore >= minScore) { side = 'BUY_CALL'; confluenceScore = callScore; dominantVotes = callVotes; }
        else if (putScore > callScore && putScore >= minScore) { side = 'BUY_PUT'; confluenceScore = putScore; dominantVotes = putVotes; }

        // Tier classification
        let tier = 'LOW';
        if (confluenceScore >= 65) tier = 'HIGH';
        else if (confluenceScore >= 45) tier = 'MEDIUM';

        // Hard gates
        const blockedReasons = [];
        if (eventGate?.blocked) {
            side = 'NO_TRADE';
            blockedReasons.push(`Event block: ${eventGate.reason}`);
        }
        if (session && !session.tradeable) {
            side = 'NO_TRADE';
            blockedReasons.push(`Session: ${session.phase} — ${session.reason}`);
        }

        // Optional ML win-probability scoring
        let mlScore = null;
        if (mlScorer && side !== 'NO_TRADE') {
            try {
                mlScore = await mlScorer({
                    side,
                    confidence_raw: confluenceScore,
                    bullAlign: callVotes.length, bearAlign: putVotes.length,
                    rsiV5: indicators.rsi14?.[indicators.rsi14.length - 1] || 50,
                    atrPct: ((indicators.atr14?.[indicators.atr14.length - 1] || 0) / last.close) * 100,
                    adxV: indicators.adx14?.[indicators.adx14.length - 1]?.adx || 20,
                    volRatio: 1,  // TODO
                    regime: indicators.regime?.regime,
                    sessionPhase: session?.phase,
                    pcr: 1,
                    atmIV: 15,
                    ivPct: 50
                });
            } catch (e) {
                mlScore = { error: e.message };
            }
        }

        // Possible-signals scoring: even strategies that didn't fire have a
        // "proximity" — how close they are to firing. Surface the top 3.
        const possibles = votes
            .filter(v => !v.fired)
            .map(v => {
                // Heuristic: parse the reason for proximity hints
                const reason = (v.reason || '').toLowerCase();
                let proximity = 20;  // default low
                let needs = v.reason || '';
                let side = v.side || null;
                if (/wait for|forming|approaching|near/.test(reason)) proximity = 65;
                if (/no rejection candle yet|but no rejection|still forming|inside orb/.test(reason)) proximity = 60;
                if (/weak body|weak volume|but volume only|but weak/.test(reason)) proximity = 70;
                if (/too quiet|too weak|stable|too late|already/.test(reason)) proximity = 25;
                if (/error|insufficient|not ready/.test(reason)) proximity = 0;
                // If side is unset, try to infer from reason
                if (!side) {
                    if (/oversold|bullish|↑|above/.test(reason)) side = 'BUY_CALL';
                    else if (/overbought|bearish|↓|below/.test(reason)) side = 'BUY_PUT';
                }
                return {
                    id: v.id, name: v.name,
                    side, proximity,
                    needs,
                    weight: v.weight
                };
            })
            .sort((a, b) => b.proximity - a.proximity)
            .slice(0, 5);

        return {
            side,
            tier,
            confluenceScore: Math.min(100, parseFloat(confluenceScore.toFixed(1))),
            callScore: parseFloat(callScore.toFixed(1)),
            putScore: parseFloat(putScore.toFixed(1)),
            votes,
            dominantVotes,
            possibles,
            adaptiveWeights: adaptiveWeights.snapshot(),
            newsAdjustment,
            mlScore,
            regime: indicators.regime,
            session,
            eventGate,
            blockedReasons,
            spot: last.close
        };
    }
}
