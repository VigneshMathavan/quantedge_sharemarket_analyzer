// server/parameter-engine.js
//
// Unified parameter computation per the master spec. Every signal that
// fires gets enriched with this full snapshot, which:
//   1. Powers the per-factor confidence breakdown UI
//   2. Logs to signal_journal for future historical similarity matching
//   3. Feeds the explainability panel ("Trend: +18, Volume: +15…")
//
// Implementation discipline:
//   • Reads ONLY from real candle data + chain rows (no synthetic)
//   • All values derived deterministically — no random, no estimates
//   • Returns NaN where data is insufficient (caller decides defaults)
//   • Idempotent — same inputs always produce same outputs

// ──────────────────────────────────────────────────────────────────
//  PRIMITIVE INDICATORS
// ──────────────────────────────────────────────────────────────────

function ema(values, period) {
    if (!values?.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
}

function sma(values, period) {
    if (values.length < period) return null;
    let s = 0;
    for (let i = values.length - period; i < values.length; i++) s += values[i];
    return s / period;
}

function stddev(values) {
    if (values.length < 2) return 0;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
    return Math.sqrt(v);
}

function atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
        tr.push(Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        ));
    }
    const series = ema(tr, period);
    return series[series.length - 1];
}

function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

// ──────────────────────────────────────────────────────────────────
//  TREND — EMA stack, ADX, DMI, Supertrend
// ──────────────────────────────────────────────────────────────────
function computeTrend(candles) {
    const closes = candles.map(c => c.close);
    const ema9   = ema(closes, 9).at(-1);
    const ema20  = ema(closes, 20).at(-1);
    const ema50  = ema(closes, 50).at(-1);
    const ema100 = ema(closes, 100).at(-1);
    const ema200 = ema(closes, 200).at(-1);
    const last = closes.at(-1);

    // Stack alignment — 1.0 = perfect bull, -1.0 = perfect bear, 0 = mixed
    let bull = 0, bear = 0;
    if (last > ema9)    bull++; else bear++;
    if (ema9 > ema20)   bull++; else bear++;
    if (ema20 > ema50)  bull++; else bear++;
    if (ema50 > ema100) bull++; else bear++;
    if (ema100 > ema200) bull++; else bear++;
    const stackAlignment = (bull - bear) / 5;   // -1 .. +1

    // EMA9 slope (price velocity)
    const ema9Series = ema(closes, 9);
    const ema9Slope5 = ema9Series.length >= 5
        ? (ema9Series.at(-1) - ema9Series.at(-5)) / Math.abs(ema9Series.at(-5)) * 100
        : 0;

    // ADX / DMI — directional movement index
    const adx = computeADX(candles, 14);

    return {
        ema9, ema20, ema50, ema100, ema200,
        priceVsEma9: last - ema9,
        priceVsEma20: last - ema20,
        priceVsEma200: last - ema200,
        stackAlignment,
        ema9Slope5Pct: parseFloat(ema9Slope5.toFixed(3)),
        adx: adx?.adx ?? null,
        plusDI: adx?.plusDI ?? null,
        minusDI: adx?.minusDI ?? null,
        trendStrength: adx?.adx >= 25 ? 'STRONG' : adx?.adx >= 15 ? 'MEDIUM' : 'WEAK'
    };
}

function computeADX(candles, period = 14) {
    if (candles.length < period * 2) return null;
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
        const upMove = c.high - p.high;
        const downMove = p.low - c.low;
        const plusDM  = upMove > downMove && upMove > 0 ? upMove : 0;
        const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
        trs.push(tr); plusDMs.push(plusDM); minusDMs.push(minusDM);
    }
    const atrSeries = ema(trs, period);
    const pDiSeries = ema(plusDMs, period).map((v, i) => 100 * v / (atrSeries[i] || 1));
    const mDiSeries = ema(minusDMs, period).map((v, i) => 100 * v / (atrSeries[i] || 1));
    const dxSeries = pDiSeries.map((p, i) => {
        const m = mDiSeries[i];
        const sum = p + m;
        return sum === 0 ? 0 : 100 * Math.abs(p - m) / sum;
    });
    const adxSeries = ema(dxSeries, period);
    return {
        adx: parseFloat((adxSeries.at(-1) || 0).toFixed(2)),
        plusDI: parseFloat((pDiSeries.at(-1) || 0).toFixed(2)),
        minusDI: parseFloat((mDiSeries.at(-1) || 0).toFixed(2))
    };
}

// ──────────────────────────────────────────────────────────────────
//  VWAP — value, slope, std-dev bands, distance, reclaim/rejection
// ──────────────────────────────────────────────────────────────────
function computeVWAP(candles) {
    if (candles.length < 5) return null;
    let cumPV = 0, cumV = 0;
    const vwapSeries = [];
    for (const c of candles) {
        const typical = (c.high + c.low + c.close) / 3;
        const v = c.volume || 1;
        cumPV += typical * v; cumV += v;
        vwapSeries.push(cumPV / cumV);
    }
    const vwap = vwapSeries.at(-1);
    const last = candles.at(-1).close;
    const distance = last - vwap;
    const distancePct = (distance / vwap) * 100;
    const slope10 = vwapSeries.length >= 10
        ? (vwap - vwapSeries.at(-10)) / Math.abs(vwapSeries.at(-10)) * 100
        : 0;
    // Std-dev bands from typical price residuals
    const residuals = [];
    for (let i = 0; i < candles.length; i++) {
        const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
        residuals.push(typical - vwapSeries[i]);
    }
    const sd = stddev(residuals);
    const reclaimSignal = candles.length >= 3 &&
        candles.at(-2).close < vwapSeries.at(-2) &&
        candles.at(-1).close > vwap;
    const rejectionSignal = candles.length >= 3 &&
        candles.at(-2).close > vwapSeries.at(-2) &&
        candles.at(-1).close < vwap;

    return {
        vwap: parseFloat(vwap.toFixed(2)),
        distance: parseFloat(distance.toFixed(2)),
        distancePct: parseFloat(distancePct.toFixed(3)),
        slope10Pct: parseFloat(slope10.toFixed(3)),
        upperBand1: parseFloat((vwap + sd).toFixed(2)),
        upperBand2: parseFloat((vwap + 2 * sd).toFixed(2)),
        lowerBand1: parseFloat((vwap - sd).toFixed(2)),
        lowerBand2: parseFloat((vwap - 2 * sd).toFixed(2)),
        reclaimSignal, rejectionSignal,
        aboveVWAP: last > vwap
    };
}

// ──────────────────────────────────────────────────────────────────
//  VOLUME — relative, spike, delta, cumulative, acceleration
// ──────────────────────────────────────────────────────────────────
function computeVolume(candles) {
    if (candles.length < 20) return null;
    const lastVol = candles.at(-1).volume || 0;
    const recent20 = candles.slice(-20).map(c => c.volume || 0);
    const avg20 = recent20.reduce((a, b) => a + b, 0) / 20;
    const relVolume = avg20 > 0 ? lastVol / avg20 : 0;
    const spike = relVolume >= 2.0;

    // Volume delta — signed by candle direction
    const delta = (candles.at(-1).close >= candles.at(-1).open ? 1 : -1) * lastVol;

    // Cumulative delta over last 20
    let cumDelta = 0;
    for (const c of candles.slice(-20)) {
        cumDelta += (c.close >= c.open ? 1 : -1) * (c.volume || 0);
    }

    // Acceleration — last 5 avg vs prior 15 avg
    const recent5 = candles.slice(-5).map(c => c.volume || 0);
    const avg5 = recent5.reduce((a, b) => a + b, 0) / 5;
    const prior15 = candles.slice(-20, -5).map(c => c.volume || 0);
    const avgPrior = prior15.reduce((a, b) => a + b, 0) / 15;
    const acceleration = avgPrior > 0 ? avg5 / avgPrior : 1;

    return {
        lastVolume: lastVol,
        avg20Volume: Math.round(avg20),
        relativeVolume: parseFloat(relVolume.toFixed(2)),
        volumeSpike: spike,
        volumeDelta: delta,
        cumulativeDelta20: cumDelta,
        accelerationRatio: parseFloat(acceleration.toFixed(2)),
        exhaustion: relVolume > 3.0 && acceleration < 0.6   // huge volume then dropping
    };
}

// ──────────────────────────────────────────────────────────────────
//  VOLATILITY — ATR state, BB width, historical vol
// ──────────────────────────────────────────────────────────────────
function computeVolatility(candles) {
    if (candles.length < 30) return null;
    const closes = candles.map(c => c.close);
    const atrNow = atr(candles, 14);

    // ATR 30 candles back for expansion/compression detection
    const atrPast = atr(candles.slice(0, -10), 14);
    const atrRatio = atrPast > 0 ? atrNow / atrPast : 1;

    // Historical volatility (close-to-close annualized)
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    const hv = stddev(returns) * Math.sqrt(252) * 100;

    // BB width as percentage of price
    const m20 = sma(closes, 20);
    const recent20 = closes.slice(-20);
    const sd20 = stddev(recent20);
    const bbWidth = (4 * sd20) / m20 * 100;

    // Squeeze: BB width < its 30-bar mean
    const bbWidthSeries = [];
    for (let i = 20; i < closes.length; i++) {
        const slice = closes.slice(i - 20, i);
        const m = slice.reduce((a, b) => a + b, 0) / 20;
        bbWidthSeries.push((4 * stddev(slice)) / m * 100);
    }
    const bbWidthMean = bbWidthSeries.length >= 30
        ? bbWidthSeries.slice(-30).reduce((a, b) => a + b, 0) / 30
        : bbWidth;
    const inSqueeze = bbWidth < bbWidthMean * 0.85;

    return {
        atr14: parseFloat((atrNow || 0).toFixed(2)),
        atrRatioVsPast: parseFloat(atrRatio.toFixed(2)),
        atrState: atrRatio >= 1.3 ? 'EXPANDING' : atrRatio <= 0.7 ? 'COMPRESSING' : 'STABLE',
        historicalVolPct: parseFloat(hv.toFixed(2)),
        bbWidthPct: parseFloat(bbWidth.toFixed(3)),
        bbWidthMean30: parseFloat(bbWidthMean.toFixed(3)),
        inSqueeze
    };
}

// ──────────────────────────────────────────────────────────────────
//  STRUCTURE — HH/HL/LH/LL, BOS, CHoCH
// ──────────────────────────────────────────────────────────────────
function computeStructure(candles) {
    if (candles.length < 20) return null;
    // Identify swing highs / lows over last 30 bars (fractal: bar > 2 bars on each side)
    const swings = [];
    for (let i = 2; i < candles.length - 2; i++) {
        const h = candles[i].high, l = candles[i].low;
        const isHigh = candles[i-1].high < h && candles[i-2].high < h &&
                       candles[i+1].high < h && candles[i+2].high < h;
        const isLow  = candles[i-1].low > l && candles[i-2].low > l &&
                       candles[i+1].low > l && candles[i+2].low > l;
        if (isHigh) swings.push({ idx: i, type: 'H', price: h, time: candles[i].time });
        if (isLow)  swings.push({ idx: i, type: 'L', price: l, time: candles[i].time });
    }
    const recent = swings.slice(-6);

    // Classify last two highs and last two lows
    const highs = recent.filter(s => s.type === 'H');
    const lows  = recent.filter(s => s.type === 'L');
    const hh = highs.length >= 2 && highs.at(-1).price > highs.at(-2).price;
    const lh = highs.length >= 2 && highs.at(-1).price < highs.at(-2).price;
    const hl = lows.length >= 2 && lows.at(-1).price > lows.at(-2).price;
    const ll = lows.length >= 2 && lows.at(-1).price < lows.at(-2).price;

    // Break of Structure (BOS) — last close breaks the prior swing high (bull) or low (bear)
    const lastClose = candles.at(-1).close;
    const lastSwingHigh = highs.at(-1)?.price;
    const lastSwingLow  = lows.at(-1)?.price;
    const bullBOS = lastSwingHigh != null && lastClose > lastSwingHigh;
    const bearBOS = lastSwingLow  != null && lastClose < lastSwingLow;

    // Change of Character — pattern flip (e.g. was making HH/HL, now made LH/LL)
    const chochBull = ll && hl;   // was going down, now making higher low
    const chochBear = hh && lh;   // was going up, now making lower high

    return {
        recentHigh: highs.at(-1)?.price ?? null,
        recentLow: lows.at(-1)?.price ?? null,
        higherHigh: hh, higherLow: hl, lowerHigh: lh, lowerLow: ll,
        bullBOS, bearBOS,
        chochBull, chochBear,
        structureTrend: hh && hl ? 'UPTREND' : ll && lh ? 'DOWNTREND' : 'RANGE'
    };
}

// ──────────────────────────────────────────────────────────────────
//  SMC — Fair Value Gap, Order Block, Liquidity sweep
// ──────────────────────────────────────────────────────────────────
function computeSMC(candles) {
    if (candles.length < 5) return null;
    const fvgs = [];
    // 3-candle FVG: gap between candle[i-2].high and candle[i].low (bullish FVG)
    for (let i = 2; i < candles.length; i++) {
        const c0 = candles[i - 2], c2 = candles[i];
        if (c2.low > c0.high) {
            fvgs.push({ idx: i, type: 'BULL', low: c0.high, high: c2.low, mid: (c0.high + c2.low) / 2 });
        } else if (c2.high < c0.low) {
            fvgs.push({ idx: i, type: 'BEAR', low: c2.high, high: c0.low, mid: (c0.low + c2.high) / 2 });
        }
    }
    const unfilled = fvgs.slice(-10);   // recent 10 only

    // Liquidity sweep — last bar makes high beyond N-bar high then closes back
    const recent20 = candles.slice(-20);
    const max20 = Math.max(...recent20.slice(0, -1).map(c => c.high));
    const min20 = Math.min(...recent20.slice(0, -1).map(c => c.low));
    const last = candles.at(-1);
    const bullSweep = last.low < min20 && last.close > min20;
    const bearSweep = last.high > max20 && last.close < max20;

    return {
        fvgsRecent: unfilled,
        fvgsCount: unfilled.length,
        liquiditySweepBull: bullSweep,
        liquiditySweepBear: bearSweep
    };
}

// ──────────────────────────────────────────────────────────────────
//  PRICE ACTION — candle anatomy
// ──────────────────────────────────────────────────────────────────
function computePriceAction(candles) {
    if (!candles.length) return null;
    const c = candles.at(-1);
    const range = c.high - c.low;
    if (range === 0) return null;
    const body = Math.abs(c.close - c.open);
    const bodyPct = (body / range) * 100;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWickPct = (upperWick / range) * 100;
    const lowerWickPct = (lowerWick / range) * 100;
    const isGreen = c.close >= c.open;

    // Pattern flags
    const isDoji      = bodyPct < 10;
    const isHammer    = lowerWickPct >= 60 && bodyPct <= 30 && upperWickPct <= 20;
    const isShooting  = upperWickPct >= 60 && bodyPct <= 30 && lowerWickPct <= 20;
    const isMarubozu  = bodyPct >= 90;
    const isMomentum  = bodyPct >= 70 && body > 0;
    const isRejection = (isGreen && lowerWickPct >= 50) || (!isGreen && upperWickPct >= 50);

    // Engulfing — needs prev candle
    let isEngulfing = false;
    if (candles.length >= 2) {
        const p = candles.at(-2);
        const prevBody = Math.abs(p.close - p.open);
        isEngulfing = body > prevBody &&
            ((isGreen && p.close < p.open && c.close > p.open && c.open < p.close) ||
             (!isGreen && p.close > p.open && c.close < p.open && c.open > p.close));
    }

    return {
        bodyPct: parseFloat(bodyPct.toFixed(1)),
        upperWickPct: parseFloat(upperWickPct.toFixed(1)),
        lowerWickPct: parseFloat(lowerWickPct.toFixed(1)),
        isGreen,
        isDoji, isHammer, isShootingStar: isShooting, isMarubozu,
        momentumCandle: isMomentum,
        rejectionCandle: isRejection,
        engulfing: isEngulfing
    };
}

// ──────────────────────────────────────────────────────────────────
//  OPTIONS CHAIN — PCR, OI, IV, Max Pain
//  (re-uses chain-snapshot output where overlap)
// ──────────────────────────────────────────────────────────────────
function computeChainParams(chain, spot) {
    if (!chain?.length) return null;
    const ces = chain.filter(r => r.type === 'CE');
    const pes = chain.filter(r => r.type === 'PE');
    const totalCallOI = ces.reduce((a, r) => a + (r.oi || 0), 0);
    const totalPutOI  = pes.reduce((a, r) => a + (r.oi || 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    // ATM IV
    const atmCE = ces.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b, ces[0]);
    const atmPE = pes.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b, pes[0]);
    const atmIV = ((atmCE.iv || 0) + (atmPE.iv || 0)) / 2;

    return {
        pcr: pcr != null ? parseFloat(pcr.toFixed(3)) : null,
        totalCallOI, totalPutOI,
        atmIV: parseFloat(atmIV.toFixed(2)),
        atmCallOI: atmCE.oi,
        atmPutOI: atmPE.oi,
        atmStrike: atmCE.strike,
        chainSize: chain.length
    };
}

// ──────────────────────────────────────────────────────────────────
//  ORCHESTRATOR — single entry point
// ──────────────────────────────────────────────────────────────────
export function computeAllParameters({ candles, chain = null, spot = null }) {
    if (!candles?.length) return null;
    const spotPrice = spot ?? candles.at(-1).close;
    return {
        ts: Date.now(),
        candleCount: candles.length,
        spot: spotPrice,
        trend:       computeTrend(candles),
        vwap:        computeVWAP(candles),
        volume:      computeVolume(candles),
        volatility:  computeVolatility(candles),
        structure:   computeStructure(candles),
        smc:         computeSMC(candles),
        priceAction: computePriceAction(candles),
        rsi14:       rsi(candles.map(c => c.close), 14),
        chain:       computeChainParams(chain, spotPrice)
    };
}

// ──────────────────────────────────────────────────────────────────
//  PER-FACTOR CONFIDENCE — scores each pillar 0-100 for the
//  explainability UI. Caller decides weights; this only emits
//  raw factor scores (deterministic from parameter snapshot).
// ──────────────────────────────────────────────────────────────────
export function computeFactorScores(params, side) {
    if (!params) return null;
    const isBull = side === 'BUY_CALL';
    const scores = {};

    // Trend score
    if (params.trend) {
        const align = isBull ? params.trend.stackAlignment : -params.trend.stackAlignment;
        const slope = isBull ? params.trend.ema9Slope5Pct : -params.trend.ema9Slope5Pct;
        const adxBonus = (params.trend.adx || 0) >= 25 ? 15 : (params.trend.adx || 0) >= 15 ? 8 : 0;
        scores.trend = clamp(50 + align * 35 + slope * 2 + adxBonus, 0, 100);
    }

    // VWAP
    if (params.vwap) {
        const above = params.vwap.aboveVWAP === isBull;
        const slopeOk = isBull ? params.vwap.slope10Pct > 0 : params.vwap.slope10Pct < 0;
        scores.vwap = clamp(50 + (above ? 25 : -25) + (slopeOk ? 15 : -10), 0, 100);
    }

    // Volume
    if (params.volume) {
        const rel = params.volume.relativeVolume || 1;
        const deltaDir = (params.volume.cumulativeDelta20 > 0) === isBull;
        scores.volume = clamp(50 + Math.min(40, (rel - 1) * 30) + (deltaDir ? 10 : -10), 0, 100);
    }

    // Volatility — ATR expansion is good for breakouts, compression for squeeze plays
    if (params.volatility) {
        const expanding = params.volatility.atrState === 'EXPANDING';
        scores.volatility = clamp(50 + (expanding ? 20 : -5) + (params.volatility.inSqueeze ? -10 : 5), 0, 100);
    }

    // Structure
    if (params.structure) {
        const bosMatch = isBull ? params.structure.bullBOS : params.structure.bearBOS;
        const trendMatch = (isBull && params.structure.structureTrend === 'UPTREND') ||
                           (!isBull && params.structure.structureTrend === 'DOWNTREND');
        scores.structure = clamp(50 + (bosMatch ? 25 : 0) + (trendMatch ? 20 : -10), 0, 100);
    }

    // SMC
    if (params.smc) {
        const sweepMatch = isBull ? params.smc.liquiditySweepBull : params.smc.liquiditySweepBear;
        scores.smc = clamp(50 + (sweepMatch ? 30 : 0) + Math.min(15, params.smc.fvgsCount * 2), 0, 100);
    }

    // Price action
    if (params.priceAction) {
        const greenMatch = params.priceAction.isGreen === isBull;
        const momBonus = params.priceAction.momentumCandle ? 15 : 0;
        const rejBonus = params.priceAction.rejectionCandle ? 10 : 0;
        scores.priceAction = clamp(50 + (greenMatch ? 15 : -10) + momBonus + rejBonus, 0, 100);
    }

    // OI / Chain
    if (params.chain) {
        const pcr = params.chain.pcr || 1;
        const pcrFav = isBull ? pcr > 1 : pcr < 0.7;
        scores.chain = clamp(50 + (pcrFav ? 25 : -10), 0, 100);
    }

    return scores;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, parseFloat(v.toFixed(1)))); }
