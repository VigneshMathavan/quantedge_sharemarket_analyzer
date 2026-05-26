// server/signal.js — Options-focused signal engine
//
// Realistic goal: 55-62% win rate with 1:2 R:R. Every signal returns full
// execution detail — strike, premium SL, time-stop, position size, max loss,
// 8-point reasoning checklist.

import { SYMBOL_MAP } from './breeze.js';

// ---------- Indicators (server-side) ----------
function ema(arr, period) {
    if (arr.length < period) return [];
    const k = 2 / (period + 1);
    const out = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    let e = sum / period;
    out.push(e);
    for (let i = period; i < arr.length; i++) {
        e = arr[i] * k + e * (1 - k);
        out.push(e);
    }
    return out;
}

function rsi(closes, period = 14) {
    if (closes.length < period + 1) return [];
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gainSum += d; else lossSum -= d;
    }
    let avgG = gainSum / period, avgL = lossSum / period;
    const out = [avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)];
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
        avgG = (avgG * (period - 1) + g) / period;
        avgL = (avgL * (period - 1) + l) / period;
        out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
    }
    return out;
}

function atr(candles, period = 14) {
    if (candles.length < period + 1) return [];
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        trs.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        ));
    }
    let a = 0;
    for (let i = 0; i < period; i++) a += trs[i];
    a /= period;
    const out = [a];
    for (let i = period; i < trs.length; i++) {
        a = (a * (period - 1) + trs[i]) / period;
        out.push(a);
    }
    return out;
}

function vwap(candles) {
    const out = [];
    let cumPV = 0, cumV = 0, lastDay = null;
    for (const c of candles) {
        const d = new Date(c.time * 1000);
        const day = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
        const tp = (c.high + c.low + c.close) / 3;
        cumPV += tp * c.volume;
        cumV += c.volume;
        out.push(cumV === 0 ? c.close : cumPV / cumV);
    }
    return out;
}

function fractals(candles, lookback = 60) {
    const start = Math.max(0, candles.length - lookback);
    const highs = [], lows = [];
    for (let i = start + 3; i < candles.length - 3; i++) {
        const c = candles[i];
        if (c.high > candles[i - 1].high && c.high > candles[i - 2].high &&
            c.high > candles[i + 1].high && c.high > candles[i + 2].high) highs.push(c.high);
        if (c.low < candles[i - 1].low && c.low < candles[i - 2].low &&
            c.low < candles[i + 1].low && c.low < candles[i + 2].low) lows.push(c.low);
    }
    return { highs, lows };
}

// ---------- Strike Selection ----------
//
// For directional buying we want a strike that:
//   - has reasonable premium (not too expensive ITM, not too cheap deep OTM)
//   - has tight bid-ask (proxied by OI volume — high OI = liquid)
//   - has acceptable delta (we want ~0.40-0.55 — ATM or 1-2 strikes ITM)
//
// Heuristic: pick ATM by default, shift 1 strike ITM if confidence very high
// (we want intrinsic protection), shift 1 OTM if vol low and we want leverage.

function selectStrike({ spot, chain, side, confidence, ivAvg }) {
    const right = side === 'BUY_CALL' ? 'CE' : 'PE';
    const candidates = chain.filter(o => o.type === right && o.oi > 100000);
    if (candidates.length === 0) return null;

    // Find ATM
    const atmStrike = candidates.reduce((best, o) =>
        Math.abs(o.strike - spot) < Math.abs(best.strike - spot) ? o : best
    , candidates[0]).strike;

    // Generate ranked candidates: ATM, ATM±1, ATM±2
    const sorted = [...new Set(candidates.map(c => c.strike))].sort((a, b) => a - b);
    const atmIdx = sorted.indexOf(atmStrike);
    const offsets = confidence >= 75 ? [-1, 0] : confidence >= 60 ? [0, 1] : [0, 1, 2];
    const choices = [];
    for (const off of offsets) {
        // For calls, "ITM" means strike < spot; for puts, strike > spot
        const idx = side === 'BUY_CALL' ? atmIdx - off : atmIdx + off;
        const strike = sorted[idx];
        if (strike == null) continue;
        const opt = candidates.find(c => c.strike === strike);
        if (opt && opt.ltp > 5) choices.push({ ...opt, offset: off });
    }
    if (choices.length === 0) {
        const fallback = candidates.find(c => c.strike === atmStrike);
        if (fallback) return { ...fallback, offset: 0, rationale: 'ATM fallback' };
        return null;
    }
    const pick = choices[0];
    pick.rationale = pick.offset < 0 ? `ITM by ${Math.abs(pick.offset)} strike (intrinsic value cushion)` :
                     pick.offset === 0 ? 'ATM (best delta/theta balance for directional)' :
                     `OTM by ${pick.offset} strike (cheaper, higher leverage)`;
    pick.ivLabel = pick.iv > ivAvg * 1.3 ? 'High' : pick.iv < ivAvg * 0.8 ? 'Low' : 'Normal';
    return pick;
}

// ---------- Position Sizing ----------
function sizePosition({ accountSize, riskPercent, premium, slPremium, lotSize }) {
    const maxRisk = accountSize * (riskPercent / 100);
    const riskPerLot = Math.max(1, (premium - slPremium) * lotSize);
    const lots = Math.max(1, Math.floor(maxRisk / riskPerLot));
    const capital = lots * lotSize * premium;
    const maxLoss = lots * lotSize * (premium - slPremium);
    return { lots, capital, maxLoss };
}

// ---------- Main Engine ----------
export class SignalEngine {
    constructor() {
        this.lastSignalTime = 0;
        this.cooldownSec = 90;
    }

    evaluate({ symbol, candles, currentPrice, chain, accountSize, riskPercent }) {
        if (!candles || candles.length < 30) {
            return this._noTrade('Insufficient history (<30 candles)');
        }
        accountSize = accountSize || 500000;
        riskPercent = riskPercent || 2;
        const meta = SYMBOL_MAP[symbol] || { lot_size: 25 };

        const closes = candles.map(c => c.close);
        const e9 = ema(closes, 9);
        const e21 = ema(closes, 21);
        const r = rsi(closes, 14);
        const a = atr(candles, 14);
        const v = vwap(candles);
        const last = candles[candles.length - 1];
        const ema9 = e9[e9.length - 1];
        const ema21 = e21[e21.length - 1];
        const rsiV = r[r.length - 1] || 50;
        const atrV = a[a.length - 1] || (last.high - last.low);
        const vwapV = v[v.length - 1] || currentPrice;
        const fr = fractals(candles, 60);
        const lastRes = fr.highs.length ? Math.max(...fr.highs) : currentPrice * 1.01;
        const lastSup = fr.lows.length ? Math.min(...fr.lows) : currentPrice * 0.99;
        const volAvg = candles.slice(-20).reduce((x, y) => x + y.volume, 0) / 20;
        const volRatio = volAvg ? last.volume / volAvg : 1;
        const bullish = ema9 > ema21 && currentPrice > vwapV;
        const bearish = ema9 < ema21 && currentPrice < vwapV;
        let side = 'NO_TRADE';
        if (bullish && rsiV > 50 && rsiV < 72) side = 'BUY_CALL';
        else if (bearish && rsiV < 50 && rsiV > 28) side = 'BUY_PUT';

        // --- 8-condition scoring ---
        const cond = {};
        let score = 0;
        cond.trendAlignment = {
            met: side !== 'NO_TRADE',
            score: side !== 'NO_TRADE' ? 20 : 0, max: 20,
            detail: bullish ? `EMA9 ${ema9.toFixed(2)} > EMA21 ${ema21.toFixed(2)} + above VWAP` :
                    bearish ? `EMA9 ${ema9.toFixed(2)} < EMA21 ${ema21.toFixed(2)} + below VWAP` :
                    `EMA9 ${ema9.toFixed(2)} ≈ EMA21 ${ema21.toFixed(2)} — sideways`
        };
        score += cond.trendAlignment.score;

        const vwapDist = ((currentPrice - vwapV) / vwapV) * 100;
        cond.vwapDistance = {
            met: Math.abs(vwapDist) > 0.05 && Math.abs(vwapDist) < 0.5,
            score: Math.min(15, Math.round(Math.abs(vwapDist) * 30)),
            max: 15,
            detail: `Price ${vwapDist >= 0 ? '+' : ''}${vwapDist.toFixed(2)}% from VWAP`
        };
        score += cond.vwapDistance.score;

        cond.momentum = {
            met: side === 'BUY_CALL' ? rsiV > 55 : side === 'BUY_PUT' ? rsiV < 45 : false,
            score: 0, max: 10,
            detail: `RSI(14) at ${rsiV.toFixed(1)}`
        };
        if (side === 'BUY_CALL') cond.momentum.score = Math.min(10, Math.max(0, Math.round((rsiV - 50) / 2.5)));
        else if (side === 'BUY_PUT') cond.momentum.score = Math.min(10, Math.max(0, Math.round((50 - rsiV) / 2.5)));
        score += cond.momentum.score;

        cond.volume = {
            met: volRatio > 1.3,
            score: volRatio > 1.3 ? Math.min(15, Math.round(volRatio * 6)) : Math.round(volRatio * 4),
            max: 15,
            detail: `Volume ${volRatio.toFixed(2)}× 20-period avg`
        };
        score += cond.volume.score;

        const brokeRes = currentPrice > lastRes;
        const brokeSup = currentPrice < lastSup;
        cond.structure = {
            met: (side === 'BUY_CALL' && brokeRes) || (side === 'BUY_PUT' && brokeSup),
            score: ((side === 'BUY_CALL' && brokeRes) || (side === 'BUY_PUT' && brokeSup)) ? 15 : (side !== 'NO_TRADE' ? 7 : 0),
            max: 15,
            detail: side === 'BUY_CALL' ? `Resistance ${lastRes.toFixed(2)} ${brokeRes ? 'broken' : 'intact'}` :
                    side === 'BUY_PUT' ? `Support ${lastSup.toFixed(2)} ${brokeSup ? 'broken' : 'intact'}` :
                    'No directional breakout'
        };
        score += cond.structure.score;

        const atrPct = (atrV / currentPrice) * 100;
        cond.volatility = {
            met: atrPct > 0.08 && atrPct < 0.45,
            score: (atrPct > 0.08 && atrPct < 0.45) ? 10 : 4,
            max: 10,
            detail: `ATR ${atrPct.toFixed(3)}% of price (${atrPct < 0.08 ? 'too quiet' : atrPct > 0.45 ? 'too wild' : 'goldilocks zone'})`
        };
        score += cond.volatility.score;

        // Options-chain awareness (only if chain provided)
        let strikePick = null;
        let chainOK = true;
        let chainDetail = 'Option chain not loaded';
        let ivAvg = 16;
        if (chain && chain.length) {
            const atmIv = chain.slice().sort((a, b) =>
                Math.abs(a.strike - currentPrice) - Math.abs(b.strike - currentPrice)
            ).slice(0, 4);
            ivAvg = atmIv.reduce((x, y) => x + y.iv, 0) / atmIv.length || 16;
            const ceOI = chain.filter(o => o.type === 'CE').reduce((x, y) => x + y.oi, 0);
            const peOI = chain.filter(o => o.type === 'PE').reduce((x, y) => x + y.oi, 0);
            const pcr = ceOI === 0 ? 1 : peOI / ceOI;
            cond.optionFlow = {
                met: (side === 'BUY_CALL' && pcr > 1.0) || (side === 'BUY_PUT' && pcr < 0.9),
                score: 0, max: 10,
                detail: `PCR ${pcr.toFixed(2)} — ${pcr > 1.1 ? 'put-heavy (bullish bias)' : pcr < 0.85 ? 'call-heavy (bearish bias)' : 'neutral'}`
            };
            if (cond.optionFlow.met) cond.optionFlow.score = 10;
            else if (Math.abs(pcr - 1) < 0.15) cond.optionFlow.score = 4;
            score += cond.optionFlow.score;

            cond.ivContext = {
                met: ivAvg > 11 && ivAvg < 22,
                score: (ivAvg > 11 && ivAvg < 22) ? 5 : 2,
                max: 5,
                detail: `ATM IV ≈ ${ivAvg.toFixed(1)}% (${ivAvg < 11 ? 'too low — expect mean revert' : ivAvg > 22 ? 'elevated — premiums expensive' : 'tradeable range'})`
            };
            score += cond.ivContext.score;

            if (side !== 'NO_TRADE') {
                strikePick = selectStrike({ spot: currentPrice, chain, side, confidence: score, ivAvg });
                if (!strikePick) chainOK = false;
                else chainDetail = `${strikePick.strike} ${strikePick.type} @ ₹${strikePick.ltp.toFixed(2)}`;
            }
        } else {
            cond.optionFlow = { met: false, score: 0, max: 10, detail: 'Option chain unavailable' };
            cond.ivContext = { met: false, score: 0, max: 5, detail: 'IV unknown' };
        }

        const confidence = Math.min(100, Math.round(score));
        const tier = confidence >= 72 ? 'HIGH' : confidence >= 55 ? 'MEDIUM' : 'LOW';

        if (side === 'NO_TRADE' || confidence < 50 || !chainOK || !strikePick) {
            return this._noTrade(`Confidence ${confidence}% — ${side === 'NO_TRADE' ? 'no directional bias' : 'below threshold or chain missing'}`,
                { conditions: cond, confidence, side });
        }

        // ---------- Execution levels ----------
        // Spot stop: 1.3× ATR or 0.25% whichever is larger
        const spotSL = side === 'BUY_CALL'
            ? currentPrice - Math.max(atrV * 1.3, currentPrice * 0.0025)
            : currentPrice + Math.max(atrV * 1.3, currentPrice * 0.0025);
        // Spot targets: 1:1.5 R, 1:3 R
        const slDist = Math.abs(currentPrice - spotSL);
        const spotT1 = side === 'BUY_CALL' ? currentPrice + slDist * 1.5 : currentPrice - slDist * 1.5;
        const spotT2 = side === 'BUY_CALL' ? currentPrice + slDist * 3.0 : currentPrice - slDist * 3.0;

        // Premium move per spot point ≈ delta. Heuristic by offset:
        // ATM ~0.50, ITM-1 ~0.62, OTM-1 ~0.38
        const delta = strikePick.offset === 0 ? 0.50 :
                      strikePick.offset < 0 ? Math.min(0.85, 0.50 + 0.12 * Math.abs(strikePick.offset)) :
                      Math.max(0.20, 0.50 - 0.12 * strikePick.offset);
        // SL premium = entry premium - (slDist * delta) — for buyer, premium falls when spot moves against
        const premium = strikePick.ltp;
        const premiumSL = Math.max(premium * 0.4, premium - slDist * delta);
        const premiumT1 = premium + Math.abs(spotT1 - currentPrice) * delta;
        const premiumT2 = premium + Math.abs(spotT2 - currentPrice) * delta;

        const size = sizePosition({
            accountSize, riskPercent, premium, slPremium: premiumSL, lotSize: meta.lot_size
        });

        // Time stop: exit by 15:15 IST if neither SL nor target hit
        const now = new Date();
        const timeStop = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 15, 0);
        const reasoning = Object.entries(cond).map(([k, v]) =>
            (v.met ? '✓ ' : '✗ ') + v.detail
        );

        const signal = {
            id: 'sig_' + Math.random().toString(16).slice(2, 10),
            time: Date.now(),
            symbol, side, confidence, tier,
            spot: { entry: currentPrice, stopLoss: spotSL, target1: spotT1, target2: spotT2 },
            option: {
                strike: strikePick.strike,
                right: strikePick.type,
                premium: parseFloat(premium.toFixed(2)),
                premiumSL: parseFloat(premiumSL.toFixed(2)),
                premiumT1: parseFloat(premiumT1.toFixed(2)),
                premiumT2: parseFloat(premiumT2.toFixed(2)),
                deltaAssumed: delta,
                oi: strikePick.oi,
                iv: strikePick.iv,
                ivLabel: strikePick.ivLabel,
                rationale: strikePick.rationale,
                lotSize: meta.lot_size
            },
            sizing: {
                lots: size.lots,
                quantity: size.lots * meta.lot_size,
                capitalRequired: Math.round(size.capital),
                maxLoss: Math.round(size.maxLoss),
                riskPercent: parseFloat((size.maxLoss / accountSize * 100).toFixed(2)),
                accountSize, riskTarget: riskPercent
            },
            riskReward: { spot: 2.0, premium: parseFloat(((premiumT1 - premium) / (premium - premiumSL)).toFixed(2)) },
            timeStop: timeStop.getTime(),
            conditions: cond,
            reasoning,
            tradeChecklist: [
                `Buy ${size.lots} lot${size.lots > 1 ? 's' : ''} (${size.lots * meta.lot_size} qty) ${strikePick.strike} ${strikePick.type} at ~₹${premium.toFixed(2)}`,
                `Set SL alert at premium ₹${premiumSL.toFixed(2)} (max loss ₹${size.maxLoss.toLocaleString('en-IN')})`,
                `Book 50% at ₹${premiumT1.toFixed(2)} (target 1), trail rest`,
                `Time-stop: exit by ${timeStop.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} regardless`,
                strikePick.ivLabel === 'High' ? '⚠ IV elevated — premium decay risk if move stalls' : '',
                `${strikePick.rationale}`
            ].filter(Boolean)
        };
        return signal;
    }

    _noTrade(reason, extra = {}) {
        return {
            side: 'NO_TRADE', time: Date.now(),
            confidence: extra.confidence || 0, tier: 'LOW',
            reason, conditions: extra.conditions || {}
        };
    }
}
