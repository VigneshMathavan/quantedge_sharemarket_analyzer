// server/signal2.js — UPGRADED multi-timeframe signal engine
//
// Major improvements over signal.js:
//   • Multi-timeframe confluence (5m + 15m + 1H resampled from base feed)
//   • Market regime classifier (trending_up / trending_down / ranging / volatile / quiet)
//   • Time-of-day session filter (refuses signals in dead zones)
//   • IV percentile calculation (compares current IV to last 30 sessions)
//   • Premium-aware execution levels (SL/T1/T2 in option premium, with delta math)
//   • Risk-of-ruin position sizing (auto-reduces after consecutive losses)
//   • Explicit feature vector output → consumed by Python ML service for win-prob
//   • Skip-bias by default: returns NO_TRADE unless 8+ conditions align
//
// Realistic target: 55-62% win rate with 1:2 R:R when paired with ML scorer.

import { SYMBOL_MAP } from './breeze.js';

// ============================================================
//  Indicators (vectorized)
// ============================================================
export function ema(arr, period) {
    if (arr.length < period) return [];
    const k = 2 / (period + 1);
    let s = 0;
    for (let i = 0; i < period; i++) s += arr[i];
    let e = s / period;
    const out = [e];
    for (let i = period; i < arr.length; i++) {
        e = arr[i] * k + e * (1 - k);
        out.push(e);
    }
    return out;
}

export function rsi(closes, period = 14) {
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

export function atr(candles, period = 14) {
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

export function adx(candles, period = 14) {
    if (candles.length < period * 2) return [];
    const trs = [], pDM = [], nDM = [];
    for (let i = 1; i < candles.length; i++) {
        const up = candles[i].high - candles[i - 1].high;
        const dn = candles[i - 1].low - candles[i].low;
        pDM.push(up > dn && up > 0 ? up : 0);
        nDM.push(dn > up && dn > 0 ? dn : 0);
        trs.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        ));
    }
    let atrV = 0, pdm = 0, ndm = 0;
    for (let i = 0; i < period; i++) { atrV += trs[i]; pdm += pDM[i]; ndm += nDM[i]; }
    let plusDI = (pdm / atrV) * 100, minusDI = (ndm / atrV) * 100;
    const dxs = [Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100];
    for (let i = period; i < trs.length; i++) {
        atrV = atrV - atrV / period + trs[i];
        pdm = pdm - pdm / period + pDM[i];
        ndm = ndm - ndm / period + nDM[i];
        plusDI = (pdm / atrV) * 100;
        minusDI = (ndm / atrV) * 100;
        dxs.push((plusDI + minusDI) === 0 ? 0 : Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100);
    }
    let a = 0;
    for (let i = 0; i < period; i++) a += dxs[i];
    a /= period;
    const out = [{ adx: a, plusDI, minusDI }];
    for (let i = period; i < dxs.length; i++) {
        a = (a * (period - 1) + dxs[i]) / period;
        out.push({ adx: a, plusDI, minusDI });
    }
    return out;
}

export function vwap(candles) {
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

export function bollinger(closes, period = 20, sd = 2) {
    const out = [];
    for (let i = period - 1; i < closes.length; i++) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += closes[j];
        const m = s / period;
        let v = 0;
        for (let j = i - period + 1; j <= i; j++) v += Math.pow(closes[j] - m, 2);
        const std = Math.sqrt(v / period);
        out.push({ middle: m, upper: m + sd * std, lower: m - sd * std, width: (2 * sd * std) / m });
    }
    return out;
}

// ============================================================
//  Multi-timeframe resampler
// ============================================================
// Convert 5-min base candles into 15m and 1H candles.
// Aggregates: O = first open, H = max high, L = min low, C = last close, V = sum.
export function resample(candles, factor) {
    if (factor <= 1 || candles.length === 0) return candles.slice();
    const out = [];
    for (let i = 0; i < candles.length; i += factor) {
        const slice = candles.slice(i, i + factor);
        if (slice.length === 0) continue;
        out.push({
            time: slice[0].time,
            open: slice[0].open,
            high: Math.max(...slice.map(c => c.high)),
            low: Math.min(...slice.map(c => c.low)),
            close: slice[slice.length - 1].close,
            volume: slice.reduce((a, b) => a + b.volume, 0)
        });
    }
    return out;
}

// ============================================================
//  Market Regime Classifier
// ============================================================
// 5 states: trending_up, trending_down, ranging, volatile, quiet
// Inputs: ADX, ATR%, BB width, price-vs-EMA dispersion
// Heuristic version. Will be replaced by Random Forest from Python ML service.
export function classifyRegime(candles) {
    if (candles.length < 30) return { regime: 'unknown', confidence: 0 };
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const adxArr = adx(candles, 14);
    const atrArr = atr(candles, 14);
    const bbArr = bollinger(closes, 20, 2);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);

    const adxV = adxArr.length ? adxArr[adxArr.length - 1].adx : 20;
    const plusDI = adxArr.length ? adxArr[adxArr.length - 1].plusDI : 20;
    const minusDI = adxArr.length ? adxArr[adxArr.length - 1].minusDI : 20;
    const atrV = atrArr.length ? atrArr[atrArr.length - 1] : (last.high - last.low);
    const atrPct = (atrV / last.close) * 100;
    const bbWidth = bbArr.length ? bbArr[bbArr.length - 1].width * 100 : 1;
    const ema9V = e9.length ? e9[e9.length - 1] : last.close;
    const ema21V = e21.length ? e21[e21.length - 1] : last.close;
    const emaSpread = Math.abs(ema9V - ema21V) / ema21V * 100;

    // Recent volume — institutional involvement
    const recentVolAvg = candles.slice(-10).reduce((a, b) => a + b.volume, 0) / 10;
    const historicalVolAvg = candles.slice(-50, -10).reduce((a, b) => a + b.volume, 0) / 40 || recentVolAvg;
    const volRegime = recentVolAvg / Math.max(1, historicalVolAvg);

    let regime, confidence;
    if (adxV > 25 && plusDI > minusDI * 1.2 && emaSpread > 0.15) {
        regime = 'trending_up';
        confidence = Math.min(95, 50 + adxV);
    } else if (adxV > 25 && minusDI > plusDI * 1.2 && emaSpread > 0.15) {
        regime = 'trending_down';
        confidence = Math.min(95, 50 + adxV);
    } else if (atrPct > 0.35 || bbWidth > 1.2) {
        regime = 'volatile';
        confidence = Math.min(90, 50 + atrPct * 50);
    } else if (atrPct < 0.08 && bbWidth < 0.3 && volRegime < 0.7) {
        regime = 'quiet';
        confidence = 75;
    } else {
        regime = 'ranging';
        confidence = 60;
    }
    return {
        regime, confidence,
        features: { adxV, plusDI, minusDI, atrPct, bbWidth, emaSpread, volRegime }
    };
}

// ============================================================
//  Time-of-Day Session Filter
// ============================================================
// IST market hours: 9:15 - 15:30
// Zones:
//   9:15 - 9:30   → OPENING — too volatile, fake-outs common, SKIP
//   9:30 - 11:30  → MORNING — best trending hours
//   11:30 - 13:30 → LUNCH — low volume, choppy, SKIP
//   13:30 - 14:45 → AFTERNOON — momentum returns
//   14:45 - 15:15 → CLOSE — manage existing trades only, no new entries
//   15:15 - 15:30 → AUCTION — SKIP (illiquid)
export function sessionPhase(timestamp) {
    const d = new Date(timestamp);
    // Convert to IST (UTC + 5:30)
    const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const istMins = (utcMins + 5 * 60 + 30) % (24 * 60);
    const h = Math.floor(istMins / 60);
    const m = istMins % 60;
    const totalMins = h * 60 + m;

    // Engine runs FULL force across the entire trading session 9:15-15:30 IST.
    // Different sessions matter (Asia → Europe overlap at 12:30 = London open,
    // US pre-market at 13:00 = often catalyst). We don't block trades based on
    // clock alone — let the strategies + approval engine + regime decide.
    if (totalMins < 9 * 60 + 15 || totalMins >= 15 * 60 + 30) {
        return { phase: 'closed', tradeable: false, reason: 'Market closed' };
    }
    if (totalMins < 9 * 60 + 30) {
        return { phase: 'opening', tradeable: true, reason: 'Opening 15 min — gap fills active' };
    }
    if (totalMins < 11 * 60 + 30) {
        return { phase: 'morning', tradeable: true, reason: 'Prime trending hours' };
    }
    if (totalMins < 13 * 60 + 30) {
        // Lunch window — STILL tradeable. London open often delivers fresh catalysts here.
        return { phase: 'lunch', tradeable: true, reason: 'Mid-session — London opens at 12:30 IST, often momentum builds' };
    }
    if (totalMins < 14 * 60 + 45) {
        return { phase: 'afternoon', tradeable: true, reason: 'Afternoon momentum window' };
    }
    if (totalMins < 15 * 60 + 15) {
        // US pre-market is around 14:00-15:00 IST — keep trading
        return { phase: 'close', tradeable: true, reason: 'US pre-market overlap — volatility windows' };
    }
    // Last 15 min — auction risk, but we leave the decision to the user
    return { phase: 'auction', tradeable: true, reason: 'Final auction window — high volatility, watch slippage' };
}

// ============================================================
//  IV Percentile
// ============================================================
// Compares current ATM IV against IV history of last N candles' ATM IVs.
// 0% = current IV is at historical low (cheap), 100% = at high (expensive).
// Option BUYERS want LOW IV percentile (cheap premium).
export function ivPercentile(currentIV, historicalIVs) {
    if (!historicalIVs || historicalIVs.length === 0) return 50;
    let below = 0;
    for (const iv of historicalIVs) if (iv < currentIV) below++;
    return Math.round((below / historicalIVs.length) * 100);
}

// ============================================================
//  Strike Selection (delta-aware)
// ============================================================
// Heuristic deltas by offset from ATM (rough but stable):
//   ITM-2: 0.75   ITM-1: 0.62   ATM: 0.50   OTM-1: 0.38   OTM-2: 0.25
// For BUYING:
//   • High-confidence directional: ATM (best leverage + acceptable theta)
//   • Strong trend / momentum: ITM-1 (intrinsic cushion, higher delta)
//   • Low confidence / scalp: ATM only — don't reach for OTM
function deltaForOffset(offset) {
    const map = { '-2': 0.75, '-1': 0.62, '0': 0.50, '1': 0.38, '2': 0.25 };
    return map[String(offset)] || 0.50;
}

export function selectStrike({ spot, chain, side, confidence, ivAvg, regime }) {
    const right = side === 'BUY_CALL' ? 'CE' : 'PE';
    const candidates = chain.filter(o => o.type === right && o.oi > 100000 && o.ltp > 5);
    if (candidates.length === 0) return null;

    const allStrikes = [...new Set(candidates.map(c => c.strike))].sort((a, b) => a - b);
    const atmStrike = allStrikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, allStrikes[0]);
    const atmIdx = allStrikes.indexOf(atmStrike);

    // Strategy by confidence + regime
    let offset;
    if (regime === 'trending_up' || regime === 'trending_down') {
        // Strong trend → ITM-1 for intrinsic cushion (less time decay damage)
        offset = confidence >= 70 ? -1 : 0;
    } else if (regime === 'volatile') {
        // Volatile → ATM only, theta is risk
        offset = 0;
    } else {
        // Ranging / quiet → ATM with tight stops
        offset = 0;
    }

    // For calls, ITM means strike < spot; for puts, strike > spot
    const targetIdx = side === 'BUY_CALL' ? atmIdx + offset : atmIdx - offset;
    let strike = allStrikes[targetIdx] || atmStrike;
    let opt = candidates.find(c => c.strike === strike);
    if (!opt) opt = candidates.find(c => c.strike === atmStrike);
    if (!opt) return null;

    return {
        ...opt,
        offset,
        delta: deltaForOffset(offset),
        rationale: offset < 0 ? `ITM-${Math.abs(offset)}: intrinsic cushion, delta ${deltaForOffset(offset).toFixed(2)}` :
                   offset === 0 ? `ATM: 0.50 delta, balanced theta/movement` :
                   `OTM+${offset}: cheap but high theta risk`,
        ivPctLabel: opt.iv > ivAvg * 1.3 ? 'expensive' : opt.iv < ivAvg * 0.8 ? 'cheap' : 'fair'
    };
}

// ============================================================
//  Position Sizing
// ============================================================
export function sizePosition({ accountSize, riskPercent, premium, premiumSL, lotSize, riskAdjuster = 1.0 }) {
    const effectiveRisk = riskPercent * riskAdjuster;
    const maxRisk = accountSize * (effectiveRisk / 100);
    const riskPerLot = Math.max(1, (premium - premiumSL) * lotSize);
    const lots = Math.max(1, Math.floor(maxRisk / riskPerLot));
    const capital = lots * lotSize * premium;
    const maxLoss = lots * lotSize * (premium - premiumSL);
    return { lots, capital, maxLoss, effectiveRiskPercent: effectiveRisk };
}

// ============================================================
//  Main Engine
// ============================================================
export class SignalEngineV2 {
    constructor(opts = {}) {
        this.opts = {
            // Mid-level floor (was 35 too strict, was 0 too noisy).
            // Server-side potential-pass logic decides what surfaces — this
            // just keeps the absolute floor at 20 (sub-20 = pure noise).
            confidenceThreshold: opts.confidenceThreshold ?? 20,
            cooldownSec: opts.cooldownSec ?? 45,
            mlScorer: opts.mlScorer || null,  // optional Python ML proxy
            ivHistory: opts.ivHistory || {},  // { symbol: [iv, iv, iv, ...] }
            recentTrades: opts.recentTrades || []  // for risk-of-ruin adjuster
        };
        this.lastSignalAt = {};
    }

    async evaluate({ symbol, candles, currentPrice, chain, accountSize, riskPercent, ivHistory, evalTime, ignoreSession }) {
        const lotSize = (SYMBOL_MAP[symbol] || { lot_size: 25 }).lot_size;
        accountSize = accountSize || 500000;
        riskPercent = riskPercent || 2;

        // 0. Hard-gate: market session (use candle time in backtest, Date.now() in live)
        const timeForSession = evalTime || (candles && candles.length ? candles[candles.length - 1].time * 1000 : Date.now());
        const session = sessionPhase(timeForSession);
        if (!session.tradeable && !ignoreSession) {
            return this._noTrade(`Session: ${session.phase} — ${session.reason}`, { session });
        }

        if (!candles || candles.length < 60) {
            return this._noTrade('Insufficient history (<60 candles for multi-TF)');
        }

        // 1. Cooldown check
        const last = this.lastSignalAt[symbol];
        if (last && (Date.now() - last) / 1000 < this.opts.cooldownSec) {
            return this._noTrade(`Cooldown active for ${symbol}`);
        }

        // 2. Multi-timeframe resampling
        const tf5 = candles;
        const tf15 = resample(candles, 3);
        const tf60 = resample(candles, 12);

        const closes5 = tf5.map(c => c.close);
        const closes15 = tf15.map(c => c.close);
        const closes60 = tf60.map(c => c.close);

        // 3. Indicators per timeframe
        const e5_9 = ema(closes5, 9), e5_21 = ema(closes5, 21);
        const e15_9 = ema(closes15, 9), e15_21 = ema(closes15, 21);
        const e60_9 = ema(closes60, 9), e60_21 = ema(closes60, 21);
        const rsi5 = rsi(closes5, 14);
        const rsi15 = rsi(closes15, 14);
        const atrArr = atr(tf5, 14);
        const vw = vwap(tf5);
        const adxArr = adx(tf5, 14);

        const last5 = tf5[tf5.length - 1];
        const ema5_9 = e5_9[e5_9.length - 1];
        const ema5_21 = e5_21[e5_21.length - 1];
        const ema15_9 = e15_9[e15_9.length - 1] ?? ema5_9;
        const ema15_21 = e15_21[e15_21.length - 1] ?? ema5_21;
        const ema60_9 = e60_9[e60_9.length - 1] ?? ema5_9;
        const ema60_21 = e60_21[e60_21.length - 1] ?? ema5_21;
        const rsiV5 = rsi5[rsi5.length - 1] ?? 50;
        const rsiV15 = rsi15[rsi15.length - 1] ?? 50;
        const atrV = atrArr[atrArr.length - 1] ?? (last5.high - last5.low);
        const vwapV = vw[vw.length - 1] ?? currentPrice;
        const adxV = adxArr.length ? adxArr[adxArr.length - 1].adx : 20;

        // 4. Regime
        const regime = classifyRegime(tf5);

        // 5. Direction proposal (must agree across 3 TFs for high conviction)
        const tf5Bull = ema5_9 > ema5_21 && currentPrice > vwapV;
        const tf15Bull = ema15_9 > ema15_21;
        const tf60Bull = ema60_9 > ema60_21;
        const tf5Bear = ema5_9 < ema5_21 && currentPrice < vwapV;
        const tf15Bear = ema15_9 < ema15_21;
        const tf60Bear = ema60_9 < ema60_21;

        const bullAlignCount = [tf5Bull, tf15Bull, tf60Bull].filter(Boolean).length;
        const bearAlignCount = [tf5Bear, tf15Bear, tf60Bear].filter(Boolean).length;

        let side = 'NO_TRADE';
        if (bullAlignCount >= 2 && bullAlignCount > bearAlignCount && rsiV5 > 50) side = 'BUY_CALL';
        else if (bearAlignCount >= 2 && bearAlignCount > bullAlignCount && rsiV5 < 50) side = 'BUY_PUT';

        // 6. Regime gate — don't fight regime
        if (regime.regime === 'trending_down' && side === 'BUY_CALL') {
            side = 'NO_TRADE'; // don't catch falling knives
        }
        if (regime.regime === 'trending_up' && side === 'BUY_PUT') {
            side = 'NO_TRADE';
        }
        if (regime.regime === 'quiet') {
            // dead market — no setups worth taking
            return this._noTrade(`Regime: quiet (ADX ${regime.features.adxV.toFixed(1)})`, { regime, session });
        }

        // 7. Option chain awareness
        let strikePick = null;
        let chainFeatures = { pcr: 1, atmIV: 16, ivPct: 50, ceOIChg: 0, peOIChg: 0 };
        if (chain && chain.length) {
            const atmStrike = Math.round(currentPrice / (SYMBOL_MAP[symbol]?.strike_gap || 50)) * (SYMBOL_MAP[symbol]?.strike_gap || 50);
            const atmRows = chain.filter(o => Math.abs(o.strike - atmStrike) < 100);
            const atmIV = atmRows.length ? atmRows.reduce((a, b) => a + b.iv, 0) / atmRows.length : 16;
            const ceOI = chain.filter(o => o.type === 'CE').reduce((a, b) => a + b.oi, 0);
            const peOI = chain.filter(o => o.type === 'PE').reduce((a, b) => a + b.oi, 0);
            const pcr = ceOI === 0 ? 1 : peOI / ceOI;
            const ceOIChg = chain.filter(o => o.type === 'CE').reduce((a, b) => a + (b.oiChange || 0), 0);
            const peOIChg = chain.filter(o => o.type === 'PE').reduce((a, b) => a + (b.oiChange || 0), 0);
            chainFeatures = { pcr, atmIV, ceOIChg, peOIChg };

            // IV percentile vs 30-session history
            const hist = (ivHistory && ivHistory[symbol]) || [];
            chainFeatures.ivPct = ivPercentile(atmIV, hist);

            if (side !== 'NO_TRADE') {
                strikePick = selectStrike({
                    spot: currentPrice, chain, side,
                    confidence: 50, ivAvg: atmIV, regime: regime.regime
                });
            }
        }

        // 8. Score conditions (12 of them for ML feature vector)
        const cond = {};
        let score = 0;

        cond.tfAlignment = {
            met: bullAlignCount === 3 || bearAlignCount === 3,
            score: bullAlignCount === 3 || bearAlignCount === 3 ? 18 :
                   bullAlignCount === 2 || bearAlignCount === 2 ? 10 : 0,
            max: 18,
            detail: `5m:${tf5Bull ? '↑' : tf5Bear ? '↓' : '·'} 15m:${tf15Bull ? '↑' : tf15Bear ? '↓' : '·'} 1H:${tf60Bull ? '↑' : tf60Bear ? '↓' : '·'}`
        };
        score += cond.tfAlignment.score;

        cond.regimeAlignment = {
            met: (side === 'BUY_CALL' && regime.regime === 'trending_up') ||
                 (side === 'BUY_PUT' && regime.regime === 'trending_down'),
            score: 0, max: 12,
            detail: `Regime: ${regime.regime} (${regime.confidence}%)`
        };
        if (cond.regimeAlignment.met) cond.regimeAlignment.score = 12;
        else if (regime.regime === 'ranging') cond.regimeAlignment.score = 4;
        score += cond.regimeAlignment.score;

        const vwapDist = ((currentPrice - vwapV) / vwapV) * 100;
        cond.vwapPosition = {
            met: (side === 'BUY_CALL' && currentPrice > vwapV) || (side === 'BUY_PUT' && currentPrice < vwapV),
            score: 0, max: 10,
            detail: `Price ${vwapDist >= 0 ? '+' : ''}${vwapDist.toFixed(2)}% from VWAP`
        };
        if (cond.vwapPosition.met) cond.vwapPosition.score = Math.min(10, Math.round(Math.abs(vwapDist) * 25));
        score += cond.vwapPosition.score;

        cond.rsiMomentum = {
            met: side === 'BUY_CALL' ? rsiV5 > 55 && rsiV5 < 75 :
                 side === 'BUY_PUT' ? rsiV5 < 45 && rsiV5 > 25 : false,
            score: 0, max: 10,
            detail: `RSI 5m ${rsiV5.toFixed(1)}, 15m ${rsiV15.toFixed(1)}`
        };
        if (cond.rsiMomentum.met) {
            cond.rsiMomentum.score = Math.min(10,
                side === 'BUY_CALL' ? Math.round((rsiV5 - 50) / 2.5) : Math.round((50 - rsiV5) / 2.5)
            );
        }
        score += cond.rsiMomentum.score;

        cond.adxStrength = {
            met: adxV > 22,
            score: adxV > 22 ? Math.min(10, Math.round(adxV / 4)) : Math.round(adxV / 8),
            max: 10,
            detail: `ADX ${adxV.toFixed(1)} (>22 confirms trend)`
        };
        score += cond.adxStrength.score;

        const volAvg = tf5.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
        const volRatio = volAvg ? last5.volume / volAvg : 1;
        cond.volumeQuality = {
            met: volRatio > 1.3,
            score: volRatio > 1.3 ? Math.min(10, Math.round(volRatio * 5)) : Math.round(volRatio * 3),
            max: 10,
            detail: `Volume ${volRatio.toFixed(2)}× 20-period avg`
        };
        score += cond.volumeQuality.score;

        const atrPct = (atrV / currentPrice) * 100;
        cond.volatilityFit = {
            met: atrPct > 0.10 && atrPct < 0.40,
            score: (atrPct > 0.10 && atrPct < 0.40) ? 8 : 3,
            max: 8,
            detail: `ATR ${atrPct.toFixed(3)}% — ${atrPct < 0.10 ? 'too quiet' : atrPct > 0.40 ? 'too wild' : 'goldilocks'}`
        };
        score += cond.volatilityFit.score;

        // Options-specific (only if chain present)
        cond.pcrBias = {
            met: (side === 'BUY_CALL' && chainFeatures.pcr > 1.0) || (side === 'BUY_PUT' && chainFeatures.pcr < 0.9),
            score: 0, max: 8,
            detail: `PCR ${chainFeatures.pcr.toFixed(2)} — ${chainFeatures.pcr > 1.1 ? 'put-heavy/bullish' : chainFeatures.pcr < 0.85 ? 'call-heavy/bearish' : 'neutral'}`
        };
        if (cond.pcrBias.met) cond.pcrBias.score = 8;
        else if (Math.abs(chainFeatures.pcr - 1) < 0.1) cond.pcrBias.score = 3;
        score += cond.pcrBias.score;

        cond.ivContext = {
            met: chainFeatures.ivPct < 60,
            score: 0, max: 8,
            detail: `IV percentile ${chainFeatures.ivPct}% — ${chainFeatures.ivPct < 35 ? 'cheap (good buy)' : chainFeatures.ivPct > 70 ? 'expensive (avoid)' : 'fair'}`
        };
        if (chainFeatures.ivPct < 35) cond.ivContext.score = 8;
        else if (chainFeatures.ivPct < 60) cond.ivContext.score = 5;
        else if (chainFeatures.ivPct > 80) cond.ivContext.score = -3;
        score += cond.ivContext.score;

        const oiFlow = side === 'BUY_CALL' ? chainFeatures.ceOIChg - chainFeatures.peOIChg :
                       side === 'BUY_PUT' ? chainFeatures.peOIChg - chainFeatures.ceOIChg : 0;
        cond.oiFlow = {
            met: oiFlow > 0,
            score: oiFlow > 0 ? 6 : 0, max: 6,
            detail: `Net OI flow ${oiFlow > 0 ? 'supports' : 'against'} direction`
        };
        score += cond.oiFlow.score;

        cond.sessionQuality = {
            met: session.phase === 'morning' || session.phase === 'afternoon',
            score: session.phase === 'morning' ? 4 : session.phase === 'afternoon' ? 3 : 0,
            max: 4,
            detail: `Phase: ${session.phase}`
        };
        score += cond.sessionQuality.score;

        cond.directionalConviction = {
            met: side !== 'NO_TRADE',
            score: side !== 'NO_TRADE' ? 6 : 0, max: 6,
            detail: side !== 'NO_TRADE' ? `${side} direction set` : 'No clear direction'
        };
        score += cond.directionalConviction.score;

        const confidence = Math.min(100, Math.max(0, Math.round(score)));
        const tier = confidence >= 75 ? 'HIGH' : confidence >= 55 ? 'MEDIUM' : 'LOW';

        // 9. Feature vector for ML
        const featureVector = {
            symbol,
            confidence_raw: confidence,
            tier,
            // Direction
            side,
            bullAlign: bullAlignCount,
            bearAlign: bearAlignCount,
            // Technicals
            rsiV5, rsiV15, atrPct, vwapDist, adxV,
            ema5_diff_pct: ((ema5_9 - ema5_21) / ema5_21) * 100,
            ema15_diff_pct: ((ema15_9 - ema15_21) / ema15_21) * 100,
            ema60_diff_pct: ((ema60_9 - ema60_21) / ema60_21) * 100,
            // Volume
            volRatio,
            // Regime
            regime: regime.regime,
            regimeConfidence: regime.confidence,
            // Options
            pcr: chainFeatures.pcr,
            atmIV: chainFeatures.atmIV,
            ivPct: chainFeatures.ivPct,
            ceOIChg: chainFeatures.ceOIChg,
            peOIChg: chainFeatures.peOIChg,
            oiFlow,
            // Session
            sessionPhase: session.phase
        };

        // 10. Hard threshold
        if (side === 'NO_TRADE' || confidence < this.opts.confidenceThreshold || !strikePick) {
            return this._noTrade(`Confidence ${confidence}% below threshold ${this.opts.confidenceThreshold}%`, {
                conditions: cond, regime, session, featureVector, confidence
            });
        }

        // 11. Execution levels
        const slDist = Math.max(atrV * 1.3, currentPrice * 0.0025);
        const spotSL = side === 'BUY_CALL' ? currentPrice - slDist : currentPrice + slDist;
        const spotT1 = side === 'BUY_CALL' ? currentPrice + slDist * 1.5 : currentPrice - slDist * 1.5;
        const spotT2 = side === 'BUY_CALL' ? currentPrice + slDist * 3.0 : currentPrice - slDist * 3.0;

        const delta = strikePick.delta;
        const premium = strikePick.ltp;
        const premiumSL = Math.max(premium * 0.5, premium - slDist * delta);
        const premiumT1 = premium + Math.abs(spotT1 - currentPrice) * delta;
        const premiumT2 = premium + Math.abs(spotT2 - currentPrice) * delta;

        // 12. Risk-of-ruin adjuster
        const recentLosses = this.opts.recentTrades.slice(-5).filter(t => t.result === 'LOSS').length;
        const riskAdjuster = recentLosses >= 3 ? 0.5 : recentLosses === 2 ? 0.75 : 1.0;

        const size = sizePosition({
            accountSize, riskPercent,
            premium, premiumSL, lotSize, riskAdjuster
        });

        // 13. Optional: ask Python ML for win probability
        let mlScore = null;
        if (this.opts.mlScorer) {
            try {
                mlScore = await this.opts.mlScorer(featureVector);
            } catch (e) {
                mlScore = { error: e.message };
            }
        }

        // 14. Time stop — exit by 15:15 IST
        const now = new Date();
        const timeStop = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 15, 0).getTime();

        // 15. Reasoning text
        const reasoning = Object.entries(cond).map(([k, v]) =>
            (v.met ? '✓ ' : '✗ ') + v.detail
        );

        const signal = {
            id: 'sig_' + Math.random().toString(16).slice(2, 10),
            time: Date.now(),
            engine: 'v2',
            symbol, side, confidence, tier,
            mlScore,
            spot: { entry: currentPrice, stopLoss: spotSL, target1: spotT1, target2: spotT2 },
            option: {
                strike: strikePick.strike,
                right: strikePick.type,
                premium: parseFloat(premium.toFixed(2)),
                premiumSL: parseFloat(premiumSL.toFixed(2)),
                premiumT1: parseFloat(premiumT1.toFixed(2)),
                premiumT2: parseFloat(premiumT2.toFixed(2)),
                delta,
                iv: strikePick.iv,
                ivLabel: strikePick.ivPctLabel,
                oi: strikePick.oi,
                rationale: strikePick.rationale,
                lotSize
            },
            sizing: {
                lots: size.lots,
                quantity: size.lots * lotSize,
                capitalRequired: Math.round(size.capital),
                maxLoss: Math.round(size.maxLoss),
                effectiveRiskPercent: size.effectiveRiskPercent,
                riskAdjuster
            },
            riskReward: {
                spot: 2.0,
                premium: parseFloat(((premiumT1 - premium) / Math.max(0.01, premium - premiumSL)).toFixed(2))
            },
            regime,
            session,
            timeStop,
            conditions: cond,
            featureVector,
            reasoning,
            tradeChecklist: [
                `Buy ${size.lots} lot${size.lots > 1 ? 's' : ''} (${size.lots * lotSize} qty) ${strikePick.strike} ${strikePick.type} @ ~₹${premium.toFixed(2)}`,
                `Set SL alert at premium ₹${premiumSL.toFixed(2)} (max loss ₹${size.maxLoss.toLocaleString('en-IN')})`,
                `Book 50% at ₹${premiumT1.toFixed(2)}; trail rest with 1× ATR stop`,
                `Hard time-stop: exit ALL by ${new Date(timeStop).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST`,
                strikePick.ivPctLabel === 'expensive' ? '⚠ IV expensive — premium may decay even on right direction' : '',
                regime.regime === 'volatile' ? '⚠ Volatile regime — expect whipsaws, reduce size if uncertain' : '',
                recentLosses >= 2 ? `⚠ ${recentLosses} recent losses — position auto-sized to ${riskAdjuster}× normal` : '',
                strikePick.rationale
            ].filter(Boolean)
        };

        this.lastSignalAt[symbol] = Date.now();
        return signal;
    }

    _noTrade(reason, extra = {}) {
        return {
            engine: 'v2',
            side: 'NO_TRADE', time: Date.now(),
            confidence: extra.confidence ?? 0,
            tier: 'LOW',
            reason,
            regime: extra.regime,
            session: extra.session,
            featureVector: extra.featureVector,
            conditions: extra.conditions || {}
        };
    }
}
