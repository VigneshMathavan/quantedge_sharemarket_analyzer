// server/active-trade.js — Tracks the open signal and watches for exit triggers.
//
// When the orchestrator fires a signal AND the user accepts it (via API call),
// we move it into the "active trade" slot. Every subsequent candle is then
// scored against EXIT criteria:
//
//   1. PRICE — current spot vs entry, SL, T1, T2
//   2. MOMENTUM DYING — body sizes shrinking, volume dropping
//   3. REGIME FLIP — Supertrend / EMA20 flipping against us
//   4. RSI EXHAUSTION — RSI crossing back through 50 against direction
//   5. TIME — approaching 15:15 IST time-stop
//
// Each fires an "exit warning" with severity. Combined score becomes the
// urgency tag: WATCH / WARN / EXIT NOW.

import { ema, rsi, atr, vwap } from './signal2.js';

class ActiveTradeTracker {
    constructor() {
        this.active = null;   // single active trade at a time
        this.history = [];    // closed trades this session
    }

    enter(signal) {
        this.active = {
            ...signal,
            enteredAt: Date.now(),
            status: 'ACTIVE',
            exitReason: null,
            exitWarnings: []
        };
        return this.active;
    }

    exit(reason = 'manual') {
        if (!this.active) return null;
        const closed = { ...this.active, exitedAt: Date.now(), status: 'CLOSED', exitReason: reason };
        this.history.push(closed);
        if (this.history.length > 50) this.history.shift();
        this.active = null;
        return closed;
    }

    getActive() { return this.active; }
    getHistory() { return this.history; }

    // Evaluate the active trade against the latest market data.
    //
    // PHILOSOPHY (per user request 2026-05-29):
    // -------------------------------------------------------------------
    // DO NOT recommend exit just because the trade is in drawdown.
    // DRAWDOWN ≠ REVERSAL. A losing position can still hit its target.
    // We only flag EXIT_NOW when ONE of these is true:
    //   1. HARD STOP — premium ≤ SL or past 15:15 time-stop
    //   2. CONFIRMED REVERSAL — 3+ corroborating signals (price + structure
    //      + momentum + forecast all flipping against) AND forecaster says
    //      P(SL) > 1.4 × P(T1).
    //
    // Drawdown alone → urgency 'ENDURE' with message "trade still has
    // potential, hold per plan". Forecast probability is the tie-breaker.
    // -------------------------------------------------------------------
    //
    // forecast (optional) = { pT1, pSL, pTimeout, verdict } from path-forecaster
    evaluate({ candles, forecast = null }) {
        if (!this.active) return null;
        const last = candles[candles.length - 1];
        const s = this.active;
        const isCall = s.side === 'BUY_CALL';
        const direction = isCall ? 1 : -1;

        // --- Premium estimate (delta-based + theta bleed) ---
        const spotMove = (last.close - s.spot.entry) * direction;
        const minutesElapsed = (Date.now() - s.time) / 60000;
        const thetaBleed = s.option.premium * 0.0008 * minutesElapsed;
        const premEstimate = Math.max(0.5, s.option.premium + spotMove * s.option.delta - thetaBleed);

        // --- P&L ---
        const lotSize = s.option.lotSize;
        const lots = s.sizing.lots;
        const pnlEstimate = (premEstimate - s.option.premium) * lots * lotSize;
        const pnlPct = (pnlEstimate / s.sizing.maxLoss) * 100;
        const inDrawdown = premEstimate < s.option.premium;
        const drawdownPct = inDrawdown ? ((s.option.premium - premEstimate) / s.option.premium) * 100 : 0;

        // Forecaster verdict — used to downgrade warnings
        const forecastFavors = !forecast ? null :
            (forecast.pT1 > forecast.pSL && forecast.verdict !== 'UNFAVORABLE');
        const forecastVetoes = forecast && forecast.verdict === 'UNFAVORABLE' && forecast.pSL > forecast.pT1 * 1.4;

        const warnings = [];
        const reasonsToHold = [];   // arguments AGAINST exit
        let warningScore = 0;
        let exitNow = false;
        let exitReason = null;

        // ------------ HARD EXIT TRIGGERS (non-negotiable) ------------
        // 1. SL hit on premium
        if (premEstimate <= s.option.premiumSL) {
            warnings.push({ tag: 'SL_HIT', msg: `Premium at SL (₹${premEstimate.toFixed(2)} ≤ ₹${s.option.premiumSL}) — hard stop`, severity: 100 });
            warningScore += 100;
            exitNow = true;
            exitReason = 'SL_HIT';
        }
        // 2. T1 hit (not an exit but a clear signal to book)
        if (!exitNow && premEstimate >= s.option.premiumT1) {
            warnings.push({ tag: 'T1_HIT', msg: `Target 1 hit — book 50%, trail rest`, severity: 60 });
            warningScore += 60;
        }
        // 3. Time stop (past 15:15 IST)
        const istMs = Date.now() + (5 * 60 + 30) * 60 * 1000;
        const totalIstMin = Math.floor(istMs / 60000) % (24 * 60);
        const timeStop = 15 * 60 + 15;
        const minToStop = timeStop - totalIstMin;
        if (minToStop <= 0 && totalIstMin >= 9 * 60 + 15) {
            warnings.push({ tag: 'TIME_STOP', msg: `Past 15:15 IST — EXIT NOW (intraday rule)`, severity: 100 });
            warningScore += 100;
            exitNow = true;
            exitReason = exitReason || 'TIME_STOP';
        } else if (minToStop > 0 && minToStop <= 10) {
            // 10-min warning but NOT auto-exit
            warnings.push({ tag: 'TIME_STOP_SOON', msg: `Time-stop in ${minToStop}m — manage manually`, severity: 30 });
            warningScore += 30;
        }

        // ------------ STRUCTURAL REVERSAL CHECKS (need confluence) ------------
        // We collect "reversal evidence" — none of these alone justify exit.
        // Only when ≥3 align AND forecaster vetoes do we elevate to EXIT_NOW.
        let reversalEvidence = 0;
        const reversalSignals = [];

        // NEAR_SL — informational only, NOT an exit trigger
        const nearSlThreshold = 0.75;  // 75% of way to spot SL
        const slPath = isCall
            ? last.close < s.spot.entry - (s.spot.entry - s.spot.stopLoss) * nearSlThreshold
            : last.close > s.spot.entry + (s.spot.stopLoss - s.spot.entry) * nearSlThreshold;
        if (!exitNow && slPath) {
            warnings.push({
                tag: 'NEAR_SL',
                msg: `Spot ${Math.round(nearSlThreshold*100)}% of way to SL — informational only, not exit`,
                severity: 20
            });
            warningScore += 20;
            reversalEvidence++;
            reversalSignals.push('near SL');
        }

        // EMA flip — reversal evidence (NOT exit alone)
        const closes = candles.map(c => c.close);
        const e20Ser = ema(closes, 20);
        if (e20Ser.length >= 5) {
            const e20Now = e20Ser[e20Ser.length - 1];
            const e20Prev5 = e20Ser[e20Ser.length - 5];
            const slope = e20Now - e20Prev5;
            const slopeAgainst = (isCall && slope < 0) || (!isCall && slope > 0);
            const crossedBack = (isCall && last.close < e20Now) || (!isCall && last.close > e20Now);
            if (slopeAgainst && crossedBack) {
                warnings.push({ tag: 'EMA_FLIP', msg: `EMA20 slope + cross flipped against trade`, severity: 25 });
                warningScore += 25;
                reversalEvidence++;
                reversalSignals.push('EMA20 flip');
            }
        }

        // RSI exhaustion — reversal evidence
        const rsiSer = rsi(closes, 14);
        const rsiV = rsiSer[rsiSer.length - 1] || 50;
        if ((isCall && rsiV < 40) || (!isCall && rsiV > 60)) {
            warnings.push({ tag: 'RSI_EXHAUSTED', msg: `RSI ${rsiV.toFixed(0)} — momentum fading`, severity: 20 });
            warningScore += 20;
            reversalEvidence++;
            reversalSignals.push('RSI exhausted');
        }

        // 3+ shrinking candles AGAINST our direction
        if (candles.length >= 4) {
            const last3 = candles.slice(-3);
            const shrinkingAgainst = last3.every(c => (isCall ? c.close < c.open : c.close > c.open))
                && last3[2].high - last3[2].low < last3[0].high - last3[0].low;
            if (shrinkingAgainst) {
                warnings.push({ tag: 'CANDLE_REJECTION', msg: `3 consecutive against-candles with shrinking range`, severity: 25 });
                warningScore += 25;
                reversalEvidence++;
                reversalSignals.push('candle rejection');
            }
        }

        // Forecast vote
        if (forecastVetoes) {
            warnings.push({ tag: 'AI_VETO', msg: `AI Forecast UNFAVORABLE — P(SL)=${forecast.pSL}% > P(T1)×1.4`, severity: 35 });
            warningScore += 35;
            reversalEvidence++;
            reversalSignals.push('AI veto');
        }

        // ------------ HOLD ARGUMENTS — forecaster sees recovery ------------
        if (inDrawdown && forecastFavors) {
            reasonsToHold.push(`📊 AI says P(T1)=${forecast.pT1}% > P(SL)=${forecast.pSL}% — recovery likely`);
        }
        if (inDrawdown && drawdownPct < 30 && minutesElapsed < 20) {
            reasonsToHold.push(`⏳ Only ${Math.round(minutesElapsed)}m in trade · avg setup needs 20-30m — give it time`);
        }
        if (premEstimate >= s.option.premium * 0.95 && premEstimate < s.option.premium * 1.05) {
            reasonsToHold.push(`📍 Near entry · trade is "working" sideways · no reversal signature`);
        }

        // ------------ CONFLUENCE EXIT — only when reversal is REAL ------------
        const confluencedReversal = reversalEvidence >= 3;
        if (!exitNow && confluencedReversal && (forecastVetoes || !forecastFavors)) {
            warnings.push({
                tag: 'CONFLUENCE_REVERSAL',
                msg: `${reversalEvidence} reversal signals aligned (${reversalSignals.join(' · ')}) and AI doesn't see recovery — scratch trade`,
                severity: 95
            });
            warningScore += 95;
            exitNow = true;
            exitReason = exitReason || 'CONFLUENCE_REVERSAL';
        }

        // ------------ URGENCY TAGGING ------------
        // OK         — no concerns, hold
        // ENDURE     — in drawdown but forecaster sees recovery, HOLD
        // WATCH      — soft warnings, no action yet
        // WARN       — multiple soft warnings, prepare to scratch if more
        // EXIT_NOW   — hard stop or confirmed reversal
        let urgency = 'OK';
        let urgencyMsg = '';
        if (exitNow) {
            urgency = 'EXIT_NOW';
            urgencyMsg = `Hard exit · ${exitReason || 'multiple signals'}`;
        } else if (inDrawdown && forecastFavors && reversalEvidence < 2) {
            urgency = 'ENDURE';
            urgencyMsg = `Drawdown -${drawdownPct.toFixed(1)}% · AI sees ${forecast.pT1}% chance T1 still hits · HOLD`;
        } else if (warningScore >= 70 || reversalEvidence >= 2) {
            urgency = 'WARN';
            urgencyMsg = `${reversalEvidence} reversal signal${reversalEvidence>1?'s':''} — watch closely, prepare exit if 3rd appears`;
        } else if (warningScore >= 25) {
            urgency = 'WATCH';
            urgencyMsg = `Minor concerns logged, trade still on plan`;
        } else {
            urgency = 'OK';
            urgencyMsg = inDrawdown
                ? `Healthy drawdown — no reversal signature, hold per plan`
                : `Trade healthy${pnlPct > 0 ? ` · +${pnlPct.toFixed(0)}% of risk` : ''}`;
        }

        return {
            premEstimate: parseFloat(premEstimate.toFixed(2)),
            pnlEstimate: Math.round(pnlEstimate),
            pnlPct: parseFloat(pnlPct.toFixed(1)),
            minutesInTrade: Math.round(minutesElapsed),
            inDrawdown,
            drawdownPct: parseFloat(drawdownPct.toFixed(1)),
            warnings,
            reasonsToHold,
            warningScore,
            reversalEvidence,
            reversalSignals,
            urgency,
            urgencyMsg,
            exitNow,
            exitReason,
            forecastFavors,
            forecastVetoes,
            spotNow: last.close
        };
    }
}

export const tracker = new ActiveTradeTracker();
