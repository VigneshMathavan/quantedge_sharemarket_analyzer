// server/approval-engine.js — AI Trade Approval Engine (V2 Rules 1-12)
//
// Mission: "Find reasons NOT to take a trade."
// Output: Approval Score 0-100, Grade A+/A/B/C/Avoid, Reasons[], Risks[]
//
// A trade is APPROVED only when ≥4 of 5 confirmation layers agree.
// Pipeline:
//   Layer Scores → Veto Check → Final Score → Grade
//
// Scores (each 0-100):
//   Trend · Volume · VWAP · EMA · Options · PCR · OI · News
//   Volatility · Liquidity · Regime · MTF Alignment

import { ema, rsi, atr, vwap } from './signal2.js';
import { isStrategyCompatibleWithRegime } from './regime-engine.js';

const NOW = () => Date.now();

function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }
function pct(n) { return Math.round(clamp(n, 0, 100)); }

// ---------- Layer scorers ----------

function scoreTrend(candles, side) {
    const closes = candles.map(c => c.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const e20Last = e20[e20.length - 1];
    const e50Last = e50[e50.length - 1];
    const close = closes[closes.length - 1];
    const isCall = side === 'BUY_CALL';

    const above20 = close > e20Last;
    const above50 = close > e50Last;
    const stack = isCall ? (e20Last > e50Last) : (e20Last < e50Last);
    const slope = isCall ? (e20Last - (e20[e20.length - 5] || e20Last)) : ((e20[e20.length - 5] || e20Last) - e20Last);

    let s = 30;
    if ((isCall && above20) || (!isCall && !above20)) s += 25;
    if ((isCall && above50) || (!isCall && !above50)) s += 20;
    if (stack) s += 15;
    if (slope > 0) s += 10;
    return pct(s);
}

function scoreVolume(candles, side) {
    const vols = candles.map(c => c.volume || 0);
    const v20avg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20 || 1;
    const vNow = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const ratio = vNow / v20avg;
    if (vNow === 0 || v20avg === 0) return 50; // unknown — neutral (indices often have 0 vol from Yahoo)
    if (ratio >= 1.8) return 90;
    if (ratio >= 1.5) return 80;
    if (ratio >= 1.2) return 65;
    if (ratio >= 0.9) return 50;
    return 30;
}

function scoreVwap(candles, side) {
    const v = vwap(candles);
    if (!v.length) return 50;
    const vNow = v[v.length - 1];
    const close = candles[candles.length - 1].close;
    const isCall = side === 'BUY_CALL';
    const above = close > vNow;
    if ((isCall && above) || (!isCall && !above)) {
        const dist = Math.abs(close - vNow) / vNow;
        return pct(60 + dist * 4000);
    }
    return pct(40 - Math.abs(close - vNow) / vNow * 2000);
}

function scoreEMA(candles, side) {
    const closes = candles.map(c => c.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const e20Last = e20[e20.length - 1];
    const e50Last = e50[e50.length - 1];
    const isCall = side === 'BUY_CALL';
    let s = 40;
    if (isCall) {
        if (e20Last > e50Last) s += 30;
        if (closes[closes.length - 1] > e20Last) s += 30;
    } else {
        if (e20Last < e50Last) s += 30;
        if (closes[closes.length - 1] < e20Last) s += 30;
    }
    return pct(s);
}

function scoreOptions(chain, side) {
    if (!chain || !chain.length) return 50;
    // Bullish: put writing rising · Bearish: call writing rising
    const isCall = side === 'BUY_CALL';
    let totalCallOiChange = 0, totalPutOiChange = 0;
    for (const r of chain) {
        totalCallOiChange += r.callOIChange || 0;
        totalPutOiChange += r.putOIChange || 0;
    }
    if (isCall) {
        // Bullish if put OI rising (writers) > call OI rising
        if (totalPutOiChange > totalCallOiChange * 1.3) return 80;
        if (totalPutOiChange > totalCallOiChange) return 65;
        if (totalCallOiChange > totalPutOiChange * 1.3) return 30;
    } else {
        if (totalCallOiChange > totalPutOiChange * 1.3) return 80;
        if (totalCallOiChange > totalPutOiChange) return 65;
        if (totalPutOiChange > totalCallOiChange * 1.3) return 30;
    }
    return 50;
}

function scorePCR(chain, side) {
    if (!chain || !chain.length) return 50;
    let callOI = 0, putOI = 0;
    for (const r of chain) { callOI += r.callOI || 0; putOI += r.putOI || 0; }
    if (callOI === 0) return 50;
    const pcr = putOI / callOI;
    const isCall = side === 'BUY_CALL';
    // PCR > 1 typically bullish (more puts written = floor)
    if (isCall) {
        if (pcr > 1.2) return 85;
        if (pcr > 1.0) return 70;
        if (pcr > 0.8) return 55;
        return 35;
    } else {
        if (pcr < 0.7) return 85;
        if (pcr < 0.9) return 70;
        if (pcr < 1.1) return 55;
        return 35;
    }
}

function scoreOI(chain, side) {
    // Same shape as scoreOptions but emphasizing build-up vs unwind
    return scoreOptions(chain, side);  // reuse
}

function scoreNews(newsSentiment, side) {
    if (!newsSentiment) return 50;
    const isCall = side === 'BUY_CALL';
    const sent = newsSentiment.sentiment || newsSentiment.score || 0;
    if (isCall && sent > 0.3) return 85;
    if (isCall && sent > 0.1) return 65;
    if (isCall && sent < -0.3) return 25;
    if (!isCall && sent < -0.3) return 85;
    if (!isCall && sent < -0.1) return 65;
    if (!isCall && sent > 0.3) return 25;
    return 50;
}

function scoreVolatility(candles, regime) {
    const atrSer = atr(candles, 14);
    const atrNow = atrSer[atrSer.length - 1] || 1;
    const atrAvg = atrSer.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrSer.length);
    const ratio = atrNow / (atrAvg || atrNow);
    if (regime === 'HIGH_VOL' && ratio > 1.5) return 80;     // matched env
    if (regime === 'LOW_VOL'  && ratio < 0.8) return 80;
    if (regime === 'LUNCH_CHOP' && ratio < 1.1) return 60;
    if (ratio > 1.0 && ratio < 1.6) return 75;
    return 50;
}

function scoreLiquidity(option) {
    if (!option) return 60;
    const oi = option.oi || 0;
    if (oi >= 2_000_000) return 90;
    if (oi >= 1_000_000) return 80;
    if (oi >= 500_000) return 70;
    if (oi >= 200_000) return 55;
    return 35;
}

function scoreRegime(regime, regimeConfidence, strategies) {
    if (regime === 'UNCLEAR') return 20;
    if (regime === 'EVENT_DRIVEN') return 35; // generally risky
    if (regime === 'LUNCH_CHOP') return 55;    // no longer penalized — global sessions overlap
    // Compatibility: how many of the firing strategies are regime-compatible?
    const compat = strategies.filter(s => isStrategyCompatibleWithRegime(s.id, regime)).length;
    const total = strategies.length || 1;
    const base = (compat / total) * 100;
    return pct(base * (regimeConfidence / 100 * 0.5 + 0.5));
}

function scoreMTF(mtfData, side) {
    if (!mtfData) return 50;
    // mtfData = { call: [..tfs..], put: [..tfs..] } from multi-tf endpoint
    const my = side === 'BUY_CALL' ? mtfData.call?.length || 0 : mtfData.put?.length || 0;
    const opp = side === 'BUY_CALL' ? mtfData.put?.length || 0 : mtfData.call?.length || 0;
    if (opp >= 2) return 25; // higher TF flagging opposite side = strong veto
    if (my >= 3) return 90;
    if (my >= 2) return 80;
    if (my === 1 && opp === 0) return 65;
    return 50;
}

function scoreTimeOfDay(candles) {
    // Engine fires FULL force across 9:15-3:30 IST. Global sessions matter:
    //   - 12:30 IST = London open (often momentum trigger)
    //   - 14:00 IST = US pre-market overlap (catalyst window)
    // We give a small bonus to high-volume windows but never penalize.
    const last = candles[candles.length - 1];
    const istMs = (last.time * 1000) + (5 * 60 + 30) * 60 * 1000;
    const istMin = Math.floor(istMs / 60000) % (24 * 60);
    if (istMin < 9 * 60 + 15 || istMin >= 15 * 60 + 30) return 50;  // off-hours, neutral
    if (istMin >= 9 * 60 + 15 && istMin <= 10 * 60 + 30) return 85;  // morning momentum
    if (istMin >= 12 * 60 + 15 && istMin <= 13 * 60 + 0) return 75;  // London open overlap
    if (istMin >= 13 * 60 + 30 && istMin <= 15 * 60 + 15) return 85; // afternoon + US pre-market
    return 70;  // every other minute of the session is still tradeable
}

// ---------- Main approval function ----------

export function approveTrade({
    side,                  // 'BUY_CALL' | 'BUY_PUT'
    candles,               // 220 candles
    chain = [],            // option chain rows
    option = null,         // selected contract { oi, iv, delta, premium, lotSize }
    spotEntry, stopLoss, target1, target2,
    firingStrategies = [], // [{ id, name, weight }]
    regime,                // { regime, confidence }
    eventGate = null,
    newsSentiment = null,
    mtfData = null,        // { call: [...], put: [...] } from /api/signals/multi-tf
    forecast = null        // { pT1, pSL, pTimeout, verdict } from path-forecaster
}) {

    const reasons = [];
    const risks = [];
    const vetoes = [];

    // ----- Layer scoring -----
    const layerScores = {
        trend:     scoreTrend(candles, side),
        volume:    scoreVolume(candles, side),
        vwap:      scoreVwap(candles, side),
        ema:       scoreEMA(candles, side),
        options:   scoreOptions(chain, side),
        pcr:       scorePCR(chain, side),
        oi:        scoreOI(chain, side),
        news:      scoreNews(newsSentiment, side),
        volatility: scoreVolatility(candles, regime?.regime),
        liquidity: scoreLiquidity(option),
        regime:    scoreRegime(regime?.regime, regime?.confidence || 0, firingStrategies),
        mtf:       scoreMTF(mtfData, side),
        timeOfDay: scoreTimeOfDay(candles)
    };

    // ----- Rule 1: ≥4 of 5 confirmation layers agree -----
    // Confirmation layers: Trend, Volume, Price Action (VWAP+EMA combined), Options (chain+pcr+oi), Regime
    const confirmLayers = {
        Trend:      layerScores.trend     >= 60,
        Volume:     layerScores.volume    >= 55, // lenient since indices often show 0 vol
        PriceAction: (layerScores.vwap + layerScores.ema) / 2 >= 60,
        Options:    ((layerScores.options + layerScores.pcr + layerScores.oi) / 3) >= 55,
        Regime:     layerScores.regime    >= 60
    };
    const passedLayers = Object.values(confirmLayers).filter(Boolean).length;
    if (passedLayers < 4) {
        vetoes.push(`Rule 1: only ${passedLayers}/5 confirmation layers passed (need ≥4)`);
    } else {
        reasons.push(`${passedLayers}/5 confirmation layers passed`);
    }

    // ----- Rule 2: regime must be clear -----
    if (!regime || regime.regime === 'UNCLEAR' || regime.confidence < 40) {
        vetoes.push('Rule 2: regime unclear — confidence ' + (regime?.confidence || 0) + '%');
    } else {
        reasons.push(`Regime: ${regime.displayLabel || regime.regime} (${regime.confidence}%)`);
    }

    // ----- Rule 3: strategy must match regime -----
    if (regime?.regime && regime.regime !== 'UNCLEAR') {
        const matches = firingStrategies.filter(s => isStrategyCompatibleWithRegime(s.id, regime.regime));
        if (matches.length === 0) {
            vetoes.push(`Rule 3: no firing strategy matches ${regime.regime}`);
        } else {
            reasons.push(`${matches.length} strategy${matches.length>1?'s':''} compatible with regime`);
        }
        const mismatched = firingStrategies.filter(s => !isStrategyCompatibleWithRegime(s.id, regime.regime));
        if (mismatched.length) {
            risks.push(`${mismatched.length} firing strategy${mismatched.length>1?'s':''} not ideal for ${regime.regime}: ${mismatched.map(m=>m.name).join(', ')}`);
        }
    }

    // ----- Rule 4: MTF alignment -----
    if (layerScores.mtf < 60) vetoes.push(`Rule 4: MTF alignment ${layerScores.mtf}% < 60`);
    else if (layerScores.mtf >= 85) reasons.push(`Strong MTF alignment (${layerScores.mtf}%)`);
    else if (layerScores.mtf >= 75) reasons.push(`Good MTF alignment (${layerScores.mtf}%)`);
    else reasons.push(`MTF alignment ${layerScores.mtf}% (watch zone)`);

    // ----- Rule 5: RR ≥ 1:2 -----
    const isCall = side === 'BUY_CALL';
    const risk = Math.abs(spotEntry - stopLoss);
    const reward = Math.abs(target1 - spotEntry);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < 2) vetoes.push(`Rule 5: RR ${rr.toFixed(2)} < 1:2`);
    else if (rr >= 4) reasons.push(`Elite RR 1:${rr.toFixed(2)}`);
    else if (rr >= 3) reasons.push(`Preferred RR 1:${rr.toFixed(2)}`);
    else reasons.push(`RR 1:${rr.toFixed(2)}`);

    // ----- Rule 6: Volume confirmation (lenient — Yahoo indices often 0) -----
    if (layerScores.volume < 50 && layerScores.volume !== 50) {
        risks.push(`Volume weak (${layerScores.volume}%)`);
    } else if (layerScores.volume >= 75) {
        reasons.push(`Volume confirms (${layerScores.volume}%)`);
    }

    // ----- Rule 7: Options confirmation -----
    if (layerScores.options >= 70) reasons.push(`Options flow ${isCall ? 'bullish' : 'bearish'} (${layerScores.options}%)`);
    else if (layerScores.options <= 40) risks.push(`Options flow against trade (${layerScores.options}%)`);

    // ----- Rule 8: News filter -----
    if (eventGate?.blocked || eventGate?.upcoming?.minutesAway < 30) {
        vetoes.push(`Rule 8: major event within 30m — move to watchlist`);
    }
    if (layerScores.news >= 70) reasons.push(`News sentiment supportive (${layerScores.news}%)`);
    else if (layerScores.news <= 30) risks.push(`News sentiment against trade`);

    // ----- Rule 9: Liquidity -----
    if (layerScores.liquidity < 50) vetoes.push(`Rule 9: option OI ${option?.oi || 0} too thin`);
    else if (layerScores.liquidity >= 80) reasons.push(`Deep liquidity (OI ${(option?.oi/1e6).toFixed(1)}M)`);

    // ----- Rule 10: Time of day (full-session, global-aware) -----
    if (layerScores.timeOfDay >= 80) reasons.push(`High-volume time window`);
    // No lunch penalty — global session overlaps keep volume meaningful

    // ----- Rule 11: Trend filter (above VWAP, EMA20, EMA50 for longs) -----
    let trendChecks = 0;
    if (layerScores.vwap >= 60) trendChecks++;
    if (layerScores.ema >= 60) trendChecks++;
    if (layerScores.trend >= 60) trendChecks++;
    if (trendChecks < 2) vetoes.push(`Rule 11: trend filter — only ${trendChecks}/3 checks pass`);

    // ----- AI Forecast veto (bonus layer) -----
    if (forecast && forecast.verdict === 'UNFAVORABLE') {
        vetoes.push(`AI Path Forecast: UNFAVORABLE — P(SL) ${forecast.pSL}% > P(T1) ${forecast.pT1}%`);
    } else if (forecast && forecast.verdict === 'FAVORABLE') {
        reasons.push(`AI Path Forecast: FAVORABLE (P(T1)=${forecast.pT1}%)`);
    }

    // ----- Final Score -----
    const w = { trend: 0.13, volume: 0.07, vwap: 0.08, ema: 0.08, options: 0.10,
                pcr: 0.06, oi: 0.06, news: 0.04, volatility: 0.05,
                liquidity: 0.05, regime: 0.13, mtf: 0.10, timeOfDay: 0.05 };
    let baseScore = 0;
    for (const k of Object.keys(w)) baseScore += (layerScores[k] || 0) * w[k];
    baseScore = Math.round(baseScore);

    // Veto penalties — each hard veto -15
    const vetoPenalty = vetoes.length * 15;
    let finalScore = Math.max(0, baseScore - vetoPenalty);

    // ----- Grade -----
    let grade = 'Avoid';
    if (finalScore >= 95) grade = 'A+';
    else if (finalScore >= 85) grade = 'A';
    else if (finalScore >= 75) grade = 'B';
    else if (finalScore >= 60) grade = 'C';
    else grade = 'Avoid';

    const decision = vetoes.length > 0 ? 'REJECT' :
                     finalScore >= 80 ? 'APPROVE' :
                     finalScore >= 60 ? 'WATCHLIST' : 'REJECT';

    return {
        decision,                    // APPROVE | WATCHLIST | REJECT
        finalScore,
        baseScore,
        vetoPenalty,
        grade,                       // A+/A/B/C/Avoid
        reasons,
        risks,
        vetoes,
        layerScores,
        confirmLayers,
        passedLayers,
        rr: parseFloat(rr.toFixed(2)),
        evaluatedAt: NOW()
    };
}
