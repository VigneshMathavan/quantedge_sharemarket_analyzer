// server/strategies/cpr-strategy.js — Wraps the CPR engine for the orchestrator.
//
// Exports TWO strategies:
//   cprBreakoutStrategy  — fires on NARROW CPR + breakout candle
//   cprReversalStrategy  — fires on WIDE CPR + rejection wick at boundary

import { computeAllCPR, evaluateCprBreakout, evaluateCprReversal } from '../cpr.js';

function buildEval(evalFn, id, name, weight) {
    return {
        id, name, weight,
        evaluate({ candles }) {
            const allCpr = computeAllCPR(candles);
            const out = evalFn({ candles, allCpr });
            if (!out.fired) {
                return {
                    fired: false,
                    side: null,
                    score: 0,
                    proximity: 20,
                    name, id, weight,
                    needs: out.reason
                };
            }
            return {
                fired: true,
                side: out.side,
                score: out.score,
                proximity: 100,
                name, id, weight,
                reason: out.reason,
                meta: { stop: out.stop, target1: out.target1, target2: out.target2 }
            };
        }
    };
}

export const cprBreakoutStrategy = buildEval(evaluateCprBreakout, 'cpr_breakout', 'CPR Breakout', 24);
export const cprReversalStrategy = buildEval(evaluateCprReversal, 'cpr_reversal', 'CPR Reversal', 22);
