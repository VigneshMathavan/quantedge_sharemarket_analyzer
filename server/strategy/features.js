// server/strategy/features.js — Comprehensive feature engineering library.
//
// For each candle in a time series, computes a feature vector with 60+ features:
//   • Trend (multi-TF EMA spreads, slope, alignment)
//   • Momentum (RSI on 3 timeframes, ROC, MACD histogram + slope)
//   • Volatility (ATR%, BB width, BB position, VIX level + delta)
//   • Volume (relative volume, on-balance volume, volume ROC)
//   • Structure (distance to N-day high/low, gap from previous close)
//   • Time (hour-of-day, day-of-week, day-of-month, days-to-expiry)
//   • Regime tags (ADX, +DI/-DI dispersion, trend strength)
//   • Cross-asset (NIFTY-SENSEX correlation, beta to peers)
//   • Lagged returns (1, 3, 5, 10 candles back)
//   • Drawdown context (% off recent peak, days in DD)
//
// Output is a flat numeric vector with stable column ordering — suitable for
// feeding XGBoost / Random Forest / Logistic Regression / etc.

import { ema, rsi, atr, vwap, bollinger, adx, resample } from '../signal2.js';

// ============================================================
//  MACD
// ============================================================
function macd(closes, fast = 12, slow = 26, signal = 9) {
    const eFast = ema(closes, fast);
    const eSlow = ema(closes, slow);
    const offset = slow - fast;
    const out = [];
    if (eSlow.length === 0) return out;
    const macdLine = [];
    for (let i = 0; i < eSlow.length; i++) {
        macdLine.push(eFast[i + offset] - eSlow[i]);
    }
    const signalLine = ema(macdLine, signal);
    const sigOffset = signal - 1;
    for (let i = 0; i < signalLine.length; i++) {
        const m = macdLine[i + sigOffset];
        const s = signalLine[i];
        out.push({ macd: m, signal: s, hist: m - s });
    }
    return out;
}

// ============================================================
//  Rate of Change
// ============================================================
function roc(closes, period) {
    const out = [];
    for (let i = period; i < closes.length; i++) {
        out.push((closes[i] - closes[i - period]) / closes[i - period] * 100);
    }
    return out;
}

// ============================================================
//  On-Balance Volume
// ============================================================
function obv(candles) {
    const out = [0];
    for (let i = 1; i < candles.length; i++) {
        const prev = out[out.length - 1];
        if (candles[i].close > candles[i - 1].close) out.push(prev + candles[i].volume);
        else if (candles[i].close < candles[i - 1].close) out.push(prev - candles[i].volume);
        else out.push(prev);
    }
    return out;
}

// ============================================================
//  N-period high/low distance
// ============================================================
function distFromNHigh(candles, period) {
    const out = [];
    for (let i = period; i < candles.length; i++) {
        let hi = candles[i - period].high;
        for (let j = i - period + 1; j <= i; j++) if (candles[j].high > hi) hi = candles[j].high;
        out.push((candles[i].close - hi) / hi * 100);
    }
    return out;
}

function distFromNLow(candles, period) {
    const out = [];
    for (let i = period; i < candles.length; i++) {
        let lo = candles[i - period].low;
        for (let j = i - period + 1; j <= i; j++) if (candles[j].low < lo) lo = candles[j].low;
        out.push((candles[i].close - lo) / lo * 100);
    }
    return out;
}

// ============================================================
//  Lagged returns
// ============================================================
function laggedReturn(candles, lag) {
    const out = [];
    for (let i = lag; i < candles.length; i++) {
        out.push((candles[i].close - candles[i - lag].close) / candles[i - lag].close * 100);
    }
    return out;
}

// ============================================================
//  Gap from previous close
// ============================================================
function gapFromPrev(candles) {
    const out = [0];
    for (let i = 1; i < candles.length; i++) {
        out.push((candles[i].open - candles[i - 1].close) / candles[i - 1].close * 100);
    }
    return out;
}

// ============================================================
//  Drawdown context
// ============================================================
function drawdownFromPeak(candles, lookback = 20) {
    const out = [];
    for (let i = lookback; i < candles.length; i++) {
        let peak = candles[i - lookback].close;
        for (let j = i - lookback + 1; j <= i; j++) if (candles[j].close > peak) peak = candles[j].close;
        out.push((candles[i].close - peak) / peak * 100);
    }
    return out;
}

// ============================================================
//  Time features
// ============================================================
function timeFeatures(timestamp) {
    const d = new Date(timestamp * 1000);
    // IST conversion
    const istMs = timestamp * 1000 + (5 * 60 + 30) * 60 * 1000;
    const ist = new Date(istMs);
    const utc = ist.getUTCHours();
    const min = ist.getUTCMinutes();
    return {
        hourIST: utc + min / 60,
        dayOfWeek: d.getUTCDay(),       // 0=Sun ... 6=Sat (IST date approximately)
        dayOfMonth: d.getUTCDate(),
        weekOfMonth: Math.ceil(d.getUTCDate() / 7),
        monthOfYear: d.getUTCMonth() + 1,
        isMonday: d.getUTCDay() === 1 ? 1 : 0,
        isFriday: d.getUTCDay() === 5 ? 1 : 0,
        isExpiryWeek: d.getUTCDate() >= 22 ? 1 : 0,  // Last Thursday of month-ish
        isMonthEnd: d.getUTCDate() >= 25 ? 1 : 0,
        timeOfDayBucket: utc < 10 ? 0 : utc < 12 ? 1 : utc < 14 ? 2 : utc < 15 ? 3 : 4
    };
}

// ============================================================
//  Cross-asset (NIFTY/SENSEX correlation)
// ============================================================
// Given a candle index and the peer's candles aligned by timestamp,
// computes rolling correlation of last N returns.
function rollingCorrelation(closes, peerCloses, period) {
    if (closes.length !== peerCloses.length) return [];
    const out = [];
    for (let i = period; i < closes.length; i++) {
        const aRet = [], bRet = [];
        for (let j = i - period + 1; j <= i; j++) {
            aRet.push((closes[j] - closes[j - 1]) / closes[j - 1]);
            bRet.push((peerCloses[j] - peerCloses[j - 1]) / peerCloses[j - 1]);
        }
        const ma = aRet.reduce((x, y) => x + y, 0) / aRet.length;
        const mb = bRet.reduce((x, y) => x + y, 0) / bRet.length;
        let num = 0, dxa = 0, dxb = 0;
        for (let k = 0; k < aRet.length; k++) {
            const da = aRet[k] - ma, db = bRet[k] - mb;
            num += da * db; dxa += da * da; dxb += db * db;
        }
        const denom = Math.sqrt(dxa * dxb);
        out.push(denom === 0 ? 0 : num / denom);
    }
    return out;
}

// ============================================================
//  Main: compute full feature vector at every candle
// ============================================================
// Returns { features: [...], columns: [...] } where features[i] is the
// vector at candle index i (or null if not enough history).
//
// `vix` is the same-length series of INDIA_VIX 1day candles (optional but recommended).
// `peer` is the SENSEX series (or vice versa) for cross-asset features (optional).
export function computeFeatures({ candles, vix = null, peer = null }) {
    if (candles.length < 50) return { features: [], columns: featureColumns() };
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const vols   = candles.map(c => c.volume);

    // Indicators on base TF
    const e9   = ema(closes, 9);
    const e21  = ema(closes, 21);
    const e50  = ema(closes, 50);
    const e200 = ema(closes, 200);
    const rsi14 = rsi(closes, 14);
    const atr14 = atr(candles, 14);
    const bb20  = bollinger(closes, 20, 2);
    const adx14 = adx(candles, 14);
    const macdSer = macd(closes, 12, 26, 9);
    const obvSer = obv(candles);
    const vwapSer = vwap(candles);

    // Multi-TF (resampled)
    const tf15 = resample(candles, 3);   // 5m → 15m
    const tf60 = resample(candles, 12);  // 5m → 1H
    const e15_9 = ema(tf15.map(c => c.close), 9);
    const e15_21 = ema(tf15.map(c => c.close), 21);
    const e60_9 = ema(tf60.map(c => c.close), 9);
    const e60_21 = ema(tf60.map(c => c.close), 21);

    // Volume average
    const volAvg20 = [];
    for (let i = 19; i < vols.length; i++) {
        const sum = vols.slice(i - 19, i + 1).reduce((a, b) => a + b, 0);
        volAvg20.push(sum / 20);
    }

    // Distance from N-period high/low
    const distHi20 = distFromNHigh(candles, 20);
    const distLo20 = distFromNLow(candles, 20);
    const distHi50 = distFromNHigh(candles, 50);

    // Lagged returns
    const lag1 = laggedReturn(candles, 1);
    const lag3 = laggedReturn(candles, 3);
    const lag5 = laggedReturn(candles, 5);
    const lag10 = laggedReturn(candles, 10);

    // Gap
    const gap = gapFromPrev(candles);

    // Drawdown
    const dd20 = drawdownFromPeak(candles, 20);
    const dd50 = drawdownFromPeak(candles, 50);

    // Rate of change
    const roc5 = roc(closes, 5);
    const roc10 = roc(closes, 10);

    // Cross-asset correlation if peer provided + aligned
    let corr20 = [];
    if (peer && peer.length === candles.length) {
        corr20 = rollingCorrelation(closes, peer.map(c => c.close), 20);
    }

    // VIX features if provided
    let vixAligned = [];
    if (vix && vix.length) {
        // Align VIX by date — use latest VIX value at each candle's date
        const vixByDay = new Map();
        for (const v of vix) {
            const day = Math.floor(v.time / 86400);
            vixByDay.set(day, v.close);
        }
        vixAligned = candles.map(c => vixByDay.get(Math.floor(c.time / 86400)) ?? null);
    }

    // ============================================================
    //  Assemble feature vector for each candle
    // ============================================================
    // Offset alignment helper — series of length N starting at candle index `startIdx`
    // means series[k] corresponds to candle[startIdx + k]
    const ema9_start = 9 - 1;       // ema(closes, 9) starts at index 8
    const ema21_start = 21 - 1;
    const ema50_start = 50 - 1;
    const ema200_start = 200 - 1;
    const rsi_start = 14;
    const atr_start = 14;
    const bb_start = 19;
    const adx_start = 14 * 2;
    const macd_start = 26 - 1 + 9 - 1;
    const volavg_start = 19;
    const dist20_start = 20;
    const dist50_start = 50;
    const lag1_start = 1;
    const lag3_start = 3;
    const lag5_start = 5;
    const lag10_start = 10;
    const dd20_start = 20;
    const dd50_start = 50;
    const roc5_start = 5;
    const roc10_start = 10;
    const corr20_start = 20;

    const features = [];
    for (let i = 0; i < candles.length; i++) {
        // Skip if insufficient history for any indicator
        if (i < 200) { features.push(null); continue; }
        const c = candles[i];
        const close = c.close;

        // EMA values
        const fEma9 = e9[i - ema9_start];
        const fEma21 = e21[i - ema21_start];
        const fEma50 = e50[i - ema50_start];
        const fEma200 = e200[i - ema200_start];
        // MultiTF EMA at this base index: map to resampled index
        const tf15Idx = Math.floor(i / 3);
        const tf60Idx = Math.floor(i / 12);
        const f15_e9 = e15_9[tf15Idx - ema9_start] ?? fEma9;
        const f15_e21 = e15_21[tf15Idx - ema21_start] ?? fEma21;
        const f60_e9 = e60_9[tf60Idx - ema9_start] ?? fEma9;
        const f60_e21 = e60_21[tf60Idx - ema21_start] ?? fEma21;

        const fRsi = rsi14[i - rsi_start];
        const fAtr = atr14[i - atr_start];
        const bbV = bb20[i - bb_start];
        const adxV = adx14[i - adx_start];
        const macdV = macdSer[i - macd_start];

        const fVolAvg = volAvg20[i - volavg_start];
        const volRatio = fVolAvg ? c.volume / fVolAvg : 1;
        const fVwap = vwapSer[i];

        const fDist20Hi = distHi20[i - dist20_start];
        const fDist20Lo = distLo20[i - dist20_start];
        const fDist50Hi = distHi50[i - dist50_start];

        const fLag1 = lag1[i - lag1_start];
        const fLag3 = lag3[i - lag3_start];
        const fLag5 = lag5[i - lag5_start];
        const fLag10 = lag10[i - lag10_start];

        const fGap = gap[i];
        const fDD20 = dd20[i - dd20_start];
        const fDD50 = dd50[i - dd50_start];
        const fRoc5 = roc5[i - roc5_start];
        const fRoc10 = roc10[i - roc10_start];

        const fCorr = corr20.length ? (corr20[i - corr20_start] ?? 0) : 0;
        const fVix = vixAligned.length ? (vixAligned[i] ?? 15) : 15;
        const fVixPrev = vixAligned.length ? (vixAligned[i - 5] ?? fVix) : 15;
        const fVixDelta = fVix - fVixPrev;

        const t = timeFeatures(c.time);

        const vec = {
            // Price + range
            open: c.open, high: c.high, low: c.low, close, volume: c.volume,
            range_pct: (c.high - c.low) / c.low * 100,
            body_pct: Math.abs(c.close - c.open) / c.low * 100,
            upper_wick_pct: (c.high - Math.max(c.close, c.open)) / c.low * 100,
            lower_wick_pct: (Math.min(c.close, c.open) - c.low) / c.low * 100,
            // Multi-TF EMA spreads
            ema_5m_spread_pct: (fEma9 - fEma21) / fEma21 * 100,
            ema_15m_spread_pct: (f15_e9 - f15_e21) / f15_e21 * 100,
            ema_60m_spread_pct: (f60_e9 - f60_e21) / f60_e21 * 100,
            price_vs_ema21_pct: (close - fEma21) / fEma21 * 100,
            price_vs_ema50_pct: (close - fEma50) / fEma50 * 100,
            price_vs_ema200_pct: (close - fEma200) / fEma200 * 100,
            // VWAP
            price_vs_vwap_pct: fVwap ? (close - fVwap) / fVwap * 100 : 0,
            // Momentum
            rsi_14: fRsi,
            macd_value: macdV?.macd ?? 0,
            macd_hist: macdV?.hist ?? 0,
            roc_5: fRoc5,
            roc_10: fRoc10,
            // Volatility
            atr_pct: fAtr ? fAtr / close * 100 : 0,
            bb_width_pct: bbV?.width * 100 ?? 0,
            bb_position: bbV ? (close - bbV.lower) / (bbV.upper - bbV.lower) : 0.5,
            // Trend strength
            adx_14: adxV?.adx ?? 20,
            plus_di: adxV?.plusDI ?? 20,
            minus_di: adxV?.minusDI ?? 20,
            di_spread: (adxV?.plusDI ?? 0) - (adxV?.minusDI ?? 0),
            // Volume
            volume_ratio: volRatio,
            obv_z: i > 50 ? (obvSer[i] - obvSer[i - 50]) / Math.abs(obvSer[i - 50] || 1) : 0,
            // Structure
            dist_from_20day_high_pct: fDist20Hi,
            dist_from_20day_low_pct: fDist20Lo,
            dist_from_50day_high_pct: fDist50Hi,
            gap_open_pct: fGap,
            drawdown_20: fDD20,
            drawdown_50: fDD50,
            // Lagged returns
            lag_ret_1: fLag1,
            lag_ret_3: fLag3,
            lag_ret_5: fLag5,
            lag_ret_10: fLag10,
            // Cross-asset
            corr_peer_20: fCorr,
            // VIX context
            vix_level: fVix,
            vix_delta_5d: fVixDelta,
            vix_high_regime: fVix > 18 ? 1 : 0,
            vix_low_regime: fVix < 12 ? 1 : 0,
            // Time
            hour_ist: t.hourIST,
            day_of_week: t.dayOfWeek,
            day_of_month: t.dayOfMonth,
            month: t.monthOfYear,
            is_monday: t.isMonday,
            is_friday: t.isFriday,
            is_expiry_week: t.isExpiryWeek,
            time_bucket: t.timeOfDayBucket,
            // Regime tags (derived)
            regime_trend_up: (fEma9 > fEma21 && f15_e9 > f15_e21 && (adxV?.adx ?? 0) > 22) ? 1 : 0,
            regime_trend_dn: (fEma9 < fEma21 && f15_e9 < f15_e21 && (adxV?.adx ?? 0) > 22) ? 1 : 0,
            regime_chop: ((adxV?.adx ?? 0) < 18 && Math.abs((fEma9 - fEma21) / fEma21) < 0.001) ? 1 : 0,
            regime_volatile: (fAtr / close * 100 > 0.35) ? 1 : 0
        };
        features.push({ time: c.time, vec });
    }
    return { features, columns: Object.keys(features.find(f => f) ? features.find(f => f).vec : {}) };
}

export function featureColumns() {
    // Hardcoded so it's available even if computeFeatures returns empty.
    return [
        'open','high','low','close','volume',
        'range_pct','body_pct','upper_wick_pct','lower_wick_pct',
        'ema_5m_spread_pct','ema_15m_spread_pct','ema_60m_spread_pct',
        'price_vs_ema21_pct','price_vs_ema50_pct','price_vs_ema200_pct',
        'price_vs_vwap_pct',
        'rsi_14','macd_value','macd_hist','roc_5','roc_10',
        'atr_pct','bb_width_pct','bb_position',
        'adx_14','plus_di','minus_di','di_spread',
        'volume_ratio','obv_z',
        'dist_from_20day_high_pct','dist_from_20day_low_pct','dist_from_50day_high_pct',
        'gap_open_pct','drawdown_20','drawdown_50',
        'lag_ret_1','lag_ret_3','lag_ret_5','lag_ret_10',
        'corr_peer_20',
        'vix_level','vix_delta_5d','vix_high_regime','vix_low_regime',
        'hour_ist','day_of_week','day_of_month','month','is_monday','is_friday','is_expiry_week','time_bucket',
        'regime_trend_up','regime_trend_dn','regime_chop','regime_volatile'
    ];
}
