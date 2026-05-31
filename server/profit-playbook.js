// server/profit-playbook.js — Structured exit guidance for active trades.
//
// Generates a "playbook" — concrete rules for when to book profits and
// when to scratch. Updated every poll based on current premium, time of day,
// gamma blast state, and proximity to S/R levels.

const IST_MIN = (msOrSec) => {
    const ms = msOrSec > 1e12 ? msOrSec : msOrSec * 1000;
    const ist = new Date(ms + (5 * 60 + 30) * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

export function buildProfitPlaybook({ trade, monitor, gamma, srLevels, candles, forecast = null }) {
    if (!trade) return null;
    const isCall = trade.side === 'BUY_CALL';
    const entry = trade.option.premium;
    const sl = trade.option.premiumSL;
    const t1 = trade.option.premiumT1;
    const t2 = trade.option.premiumT2;
    const cur = monitor?.premEstimate || entry;
    const pnlPct = ((cur - entry) / entry) * 100;
    const distT1Pct = ((t1 - cur) / cur) * 100;
    const distSlPct = ((cur - sl) / cur) * 100;
    const istMin = IST_MIN(candles?.[candles.length - 1]?.time || Date.now() / 1000);
    const minsToClose = (15 * 60 + 15) - istMin;
    const minutesInTrade = monitor?.minutesInTrade || 0;

    const rules = [];

    // ----- Stage 1: Pre-T1 — HOLD bias when forecast is favorable -----
    const forecastFavors = forecast && forecast.pT1 > forecast.pSL && forecast.verdict !== 'UNFAVORABLE';
    const forecastVetoes = forecast && forecast.verdict === 'UNFAVORABLE';

    if (pnlPct < 0) {
        // In drawdown — DON'T panic. Use forecast as tie-breaker.
        if (forecastVetoes) {
            rules.push({
                tag: 'FORECAST_AGAINST',
                urgency: 'HIGH',
                text: `⚠ AI Forecast UNFAVORABLE — P(SL)=${forecast.pSL}% > P(T1)=${forecast.pT1}%. Consider scratching if EMA20 also flipped.`
            });
        } else if (forecastFavors) {
            rules.push({
                tag: 'HOLD_FORECAST_GOOD',
                urgency: 'LOW',
                text: `📊 Drawdown ${(-pnlPct).toFixed(1)}% — BUT AI says P(T1)=${forecast.pT1}% vs P(SL)=${forecast.pSL}%. HOLD per plan. Most winners draw down first.`
            });
        } else if (distSlPct < 15) {
            // Premium very close to SL but no forecast → still informational
            rules.push({
                tag: 'SL_PROXIMITY',
                urgency: 'MEDIUM',
                text: `🛑 Premium ${distSlPct.toFixed(0)}% from SL. Watch for confluence reversal (EMA flip + RSI exhaust + AI veto). Don't pre-empt.`
            });
        } else {
            rules.push({
                tag: 'GIVE_IT_TIME',
                urgency: 'LOW',
                text: `Drawdown ${(-pnlPct).toFixed(1)}% · ${minutesInTrade}m in trade. Avg setup hits T1 within 20-30m — give it ${Math.max(0, 25 - minutesInTrade)}m more before reassessing.`
            });
        }
    } else if (pnlPct < 25) {
        rules.push({
            tag: 'BUILDING',
            urgency: 'LOW',
            text: `+${pnlPct.toFixed(1)}% · target +${((t1 - entry) / entry * 100).toFixed(0)}%. Hold — let momentum work.`
        });
    } else if (pnlPct < 50) {
        rules.push({
            tag: 'LOCK_30_TRAIL',
            urgency: 'MEDIUM',
            text: `🔒 Lock 30% of lots at +${pnlPct.toFixed(0)}%. Move SL to entry on remaining.`
        });
    }

    // ----- Stage 2: At/Past T1 -----
    if (cur >= t1) {
        rules.push({
            tag: 'T1_BOOK_50',
            urgency: 'HIGH',
            text: `🎯 T1 HIT — book 50% of lots immediately. Move SL on rest to entry + small buffer.`
        });
        // Trail logic
        if (cur >= t1 * 1.15) {
            rules.push({
                tag: 'TRAIL_T2',
                urgency: 'MEDIUM',
                text: `Trail remaining with last 3-candle low. T2 at ₹${t2.toFixed(2)} — book 30% more there.`
            });
        }
    }
    if (cur >= t2) {
        rules.push({
            tag: 'T2_BOOK_30',
            urgency: 'HIGH',
            text: `🚀 T2 HIT — book another 30%. Run final 20% with trailing stop on EMA20.`
        });
    }

    // ----- Stage 3: Time decay management -----
    if (minsToClose <= 30 && minsToClose > 15) {
        rules.push({
            tag: 'THETA_ACCEL',
            urgency: 'MEDIUM',
            text: `⏳ ${minsToClose}m to 15:15 IST. Theta accelerates fast now — exit if not progressing toward T1.`
        });
    } else if (minsToClose <= 15 && minsToClose > 0) {
        rules.push({
            tag: 'TIME_STOP_SOON',
            urgency: 'HIGH',
            text: `🚨 ${minsToClose}m to time-stop. Close manually if at +20% or above; otherwise flat exit.`
        });
    } else if (minsToClose <= 0) {
        rules.push({
            tag: 'TIME_STOP_NOW',
            urgency: 'CRITICAL',
            text: `🛑 Past 15:15 — EXIT NOW. Theta bleed compounds + EOD volatility risk.`
        });
    }

    // ----- Stage 4: Global session overlap notice -----
    // No lunch penalty — London open at 12:30 IST often brings momentum,
    // US pre-market at 14:00 IST too. Just inform the trader.
    if (istMin >= 12 * 60 + 25 && istMin <= 12 * 60 + 35) {
        rules.push({
            tag: 'LONDON_OPEN',
            urgency: 'LOW',
            text: `🌍 London open ~12:30 IST — global flow incoming, watch for momentum shift.`
        });
    }
    if (istMin >= 13 * 60 + 55 && istMin <= 14 * 60 + 5) {
        rules.push({
            tag: 'US_PREMARKET',
            urgency: 'LOW',
            text: `🌎 US pre-market ~14:00 IST — catalyst window opening.`
        });
    }

    // ----- Stage 5: Gamma blast guidance -----
    if (gamma?.severity >= 70) {
        rules.push({
            tag: 'GAMMA_BLAST_HOLD',
            urgency: 'HIGH',
            text: `🚀 GAMMA BLAST ACTIVE (severity ${gamma.severity}). Hold core position — even small spot move = explosive gain. Lift trailing stops.`
        });
    } else if (gamma?.severity >= 50) {
        rules.push({
            tag: 'GAMMA_HOT',
            urgency: 'MEDIUM',
            text: `🔥 Γ=${gamma.gamma?.toFixed(4)}. A 0.1% spot move ≈ +${gamma.expectedMoveFor0p1Pct}% premium. Watch closely.`
        });
    }

    // ----- Stage 6: S/R proximity -----
    if (srLevels && candles?.length) {
        const spot = candles[candles.length - 1].close;
        const nearestSupport = srLevels.support?.sort((a, b) => Math.abs(spot - a.price) - Math.abs(spot - b.price))[0];
        const nearestResistance = srLevels.resistance?.sort((a, b) => Math.abs(spot - a.price) - Math.abs(spot - b.price))[0];

        if (isCall && nearestResistance) {
            const dist = ((nearestResistance.price - spot) / spot) * 100;
            if (Math.abs(dist) < 0.25 && dist > 0) {
                rules.push({
                    tag: 'NEAR_RESISTANCE',
                    urgency: 'MEDIUM',
                    text: `⚠ Spot ${dist.toFixed(2)}% below resistance ${nearestResistance.price}. Book partial if rejected at level.`
                });
            }
        }
        if (!isCall && nearestSupport) {
            const dist = ((spot - nearestSupport.price) / spot) * 100;
            if (Math.abs(dist) < 0.25 && dist > 0) {
                rules.push({
                    tag: 'NEAR_SUPPORT',
                    urgency: 'MEDIUM',
                    text: `⚠ Spot ${dist.toFixed(2)}% above support ${nearestSupport.price}. Book partial if bounce.`
                });
            }
        }
    }

    // ----- Default if nothing else -----
    if (rules.length === 0) {
        rules.push({ tag: 'HOLD', urgency: 'LOW', text: 'Trade looks healthy. Hold per plan: book 50% at T1, trail with EMA20.' });
    }

    return {
        rules,
        currentPnlPct: parseFloat(pnlPct.toFixed(1)),
        distToT1Pct: parseFloat(distT1Pct.toFixed(1)),
        distToSlPct: parseFloat(distSlPct.toFixed(1)),
        minsToClose,
        defaultPlan: '50% at T1 · 30% at T2 · trail 20% on EMA20 break'
    };
}
