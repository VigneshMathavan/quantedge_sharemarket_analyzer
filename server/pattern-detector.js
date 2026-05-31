// server/pattern-detector.js — Detects forming candlestick patterns BEFORE the
// candle completes. Returns probability that the pattern WILL complete based on
// current shape + prior context.
//
// Patterns covered:
//   • Bullish/Bearish Engulfing
//   • Hammer / Inverted Hammer
//   • Shooting Star
//   • Doji (indecision)
//   • Pin Bar (rejection)
//   • Bullish/Bearish Marubozu (strong trend)
//   • Morning/Evening Star (3-candle reversal)
//   • Three White Soldiers / Three Black Crows
//   • Inside Bar / Outside Bar
//   • Tweezers Top/Bottom
//
// Input: array of candles where LAST candle is currently forming (not closed yet).
// Output: detected patterns with completion probability + bias.

function abs(x) { return Math.abs(x); }
function pct(n, total) { return total ? (n / total) : 0; }

function shapeOf(c) {
    const body = abs(c.close - c.open);
    const range = c.high - c.low || 1;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const bullish = c.close >= c.open;
    return {
        body, range, upperWick, lowerWick, bullish,
        bodyPct: body / range,
        upperWickPct: upperWick / range,
        lowerWickPct: lowerWick / range
    };
}

function detectHammer(s) {
    return s.bodyPct < 0.35 && s.lowerWickPct > 0.55 && s.upperWickPct < 0.10;
}
function detectInverseHammer(s) {
    return s.bodyPct < 0.35 && s.upperWickPct > 0.55 && s.lowerWickPct < 0.10;
}
function detectDoji(s) {
    return s.bodyPct < 0.10 && s.upperWickPct > 0.25 && s.lowerWickPct > 0.25;
}
function detectMarubozu(s) {
    return s.bodyPct > 0.90;
}

// Engulfing: current body wraps prior body
function detectEngulfing(prev, cur) {
    if (!prev || !cur) return null;
    const pBull = prev.close >= prev.open;
    const cBull = cur.close >= cur.open;
    if (pBull === cBull) return null;
    const wrapsHigh = Math.max(cur.open, cur.close) >= Math.max(prev.open, prev.close);
    const wrapsLow = Math.min(cur.open, cur.close) <= Math.min(prev.open, prev.close);
    if (wrapsHigh && wrapsLow) return cBull ? 'BULL_ENGULF' : 'BEAR_ENGULF';
    return null;
}

// Three-candle: Morning Star / Evening Star
function detectStar(prev2, prev1, cur) {
    if (!prev2 || !prev1 || !cur) return null;
    const p2bull = prev2.close > prev2.open;
    const cbull = cur.close > cur.open;
    const smallBody = abs(prev1.close - prev1.open) < abs(prev2.close - prev2.open) * 0.4;
    const midOpenGap = prev1.open < Math.min(prev2.open, prev2.close);
    const midOpenGapUp = prev1.open > Math.max(prev2.open, prev2.close);
    // Morning Star: bearish, small, bullish (recovers >50% of first)
    if (!p2bull && smallBody && cbull && cur.close > (prev2.open + prev2.close) / 2 && midOpenGap) {
        return 'MORNING_STAR';
    }
    // Evening Star: bullish, small, bearish
    if (p2bull && smallBody && !cbull && cur.close < (prev2.open + prev2.close) / 2 && midOpenGapUp) {
        return 'EVENING_STAR';
    }
    return null;
}

// Three soldiers / crows
function detectThreeIn(candles) {
    if (!candles || candles.length < 3) return null;
    const last3 = candles.slice(-3);
    const allBull = last3.every(c => c.close > c.open);
    const allBear = last3.every(c => c.close < c.open);
    const allGrow = last3[2].close > last3[1].close && last3[1].close > last3[0].close;
    const allFall = last3[2].close < last3[1].close && last3[1].close < last3[0].close;
    if (allBull && allGrow) return 'THREE_SOLDIERS';
    if (allBear && allFall) return 'THREE_CROWS';
    return null;
}

// Tweezers: matching highs (top) or lows (bottom)
function detectTweezer(prev, cur) {
    if (!prev || !cur) return null;
    const highMatch = abs(prev.high - cur.high) / cur.high < 0.0005;
    const lowMatch = abs(prev.low - cur.low) / cur.low < 0.0005;
    if (highMatch && (prev.close > prev.open) && (cur.close < cur.open)) return 'TWEEZER_TOP';
    if (lowMatch && (prev.close < prev.open) && (cur.close > cur.open)) return 'TWEEZER_BOTTOM';
    return null;
}

// Inside / Outside bar
function detectInsideOutside(prev, cur) {
    if (!prev || !cur) return null;
    if (cur.high < prev.high && cur.low > prev.low) return 'INSIDE_BAR';
    if (cur.high > prev.high && cur.low < prev.low) return 'OUTSIDE_BAR';
    return null;
}

// Trend context — used to upgrade reversal patterns when at trend extreme
function trendContext(candles) {
    if (candles.length < 20) return 'unknown';
    const closes = candles.slice(-20).map(c => c.close);
    const slope = (closes[19] - closes[0]) / closes[0];
    if (slope > 0.005) return 'uptrend';
    if (slope < -0.005) return 'downtrend';
    return 'sideways';
}

// Main entry: pass full candle series ending with the FORMING candle.
// candleProgress (0-1) = fraction of expected candle time elapsed.
//   • 0 = candle just started
//   • 1 = candle nearly closed
// Higher progress → higher completion probability for static patterns.
export function detectPatterns(candles, candleProgress = 0.5) {
    if (!candles || candles.length < 3) return { patterns: [], summary: null };
    const cur = candles[candles.length - 1];
    const prev1 = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    const sCur = shapeOf(cur);
    const sPrev = prev1 ? shapeOf(prev1) : null;
    const ctx = trendContext(candles);
    const found = [];

    // Confidence formula: shape strength × candle-progress × trend confluence
    function emit(name, bias, baseShape, ctxBoost, note) {
        const trendMatch =
            (bias === 'BULLISH' && ctx === 'downtrend') ? 1.0 :    // reversal at trend extreme
            (bias === 'BEARISH' && ctx === 'uptrend')   ? 1.0 :
            (bias === 'BULLISH' && ctx === 'uptrend')   ? 0.75 :   // continuation
            (bias === 'BEARISH' && ctx === 'downtrend') ? 0.75 :
            0.5;
        const conf = Math.round(baseShape * trendMatch * (0.4 + 0.6 * candleProgress) * 100);
        found.push({ pattern: name, bias, confidence: Math.min(100, conf), note, ctx });
    }

    // Single-candle patterns
    if (detectHammer(sCur)) {
        emit('Hammer', 'BULLISH', 0.85, ctx === 'downtrend' ? 1.2 : 0.8,
             `Long lower wick ${(sCur.lowerWickPct*100).toFixed(0)}% — buyers rejected lows`);
    }
    if (detectInverseHammer(sCur)) {
        emit('Inverse Hammer', 'BULLISH', 0.65, 0.9,
             `Long upper wick at bottom — possible reversal probe`);
    }
    if (detectInverseHammer(sCur) && ctx === 'uptrend') {
        emit('Shooting Star', 'BEARISH', 0.85, 1.2,
             `Upper wick ${(sCur.upperWickPct*100).toFixed(0)}% at uptrend top — sellers fading rally`);
    }
    if (detectDoji(sCur)) {
        emit('Doji', 'NEUTRAL', 0.55, 0.9,
             `Indecision — body ${(sCur.bodyPct*100).toFixed(0)}%, watch next candle`);
    }
    if (detectMarubozu(sCur)) {
        emit(sCur.bullish ? 'Bullish Marubozu' : 'Bearish Marubozu',
             sCur.bullish ? 'BULLISH' : 'BEARISH', 0.85, 1.0,
             `Full body ${(sCur.bodyPct*100).toFixed(0)}% — one-sided control`);
    }

    // Two-candle
    const eng = detectEngulfing(prev1, cur);
    if (eng) {
        emit(eng === 'BULL_ENGULF' ? 'Bullish Engulfing' : 'Bearish Engulfing',
             eng === 'BULL_ENGULF' ? 'BULLISH' : 'BEARISH', 0.90, 1.2,
             `Current body engulfs prior — momentum flip`);
    }
    const tw = detectTweezer(prev1, cur);
    if (tw) {
        emit(tw === 'TWEEZER_TOP' ? 'Tweezer Top' : 'Tweezer Bottom',
             tw === 'TWEEZER_TOP' ? 'BEARISH' : 'BULLISH', 0.70, 1.0,
             `Matching ${tw==='TWEEZER_TOP'?'highs':'lows'} — level rejection`);
    }
    const io = detectInsideOutside(prev1, cur);
    if (io === 'INSIDE_BAR') {
        emit('Inside Bar', 'NEUTRAL', 0.55, 0.9,
             `Compression — breakout candidate, direction unclear yet`);
    } else if (io === 'OUTSIDE_BAR') {
        emit('Outside Bar', sCur.bullish ? 'BULLISH' : 'BEARISH', 0.75, 1.0,
             `Wider range with ${sCur.bullish?'bull':'bear'} close — momentum surge`);
    }

    // Three-candle
    const star = detectStar(prev2, prev1, cur);
    if (star) {
        emit(star === 'MORNING_STAR' ? 'Morning Star' : 'Evening Star',
             star === 'MORNING_STAR' ? 'BULLISH' : 'BEARISH', 0.92, 1.3,
             `Classic 3-candle reversal — high reliability`);
    }
    const trio = detectThreeIn(candles);
    if (trio) {
        emit(trio === 'THREE_SOLDIERS' ? 'Three White Soldiers' : 'Three Black Crows',
             trio === 'THREE_SOLDIERS' ? 'BULLISH' : 'BEARISH', 0.85, 1.0,
             `3 consecutive ${trio==='THREE_SOLDIERS'?'green':'red'} candles — sustained momentum`);
    }

    // Sort by confidence desc
    found.sort((a, b) => b.confidence - a.confidence);

    // Top-level summary
    let summary = null;
    if (found.length) {
        const top = found[0];
        const biasVote = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
        for (const p of found) biasVote[p.bias] += p.confidence;
        const finalBias = Object.entries(biasVote).sort((a, b) => b[1] - a[1])[0][0];
        summary = {
            primaryPattern: top.pattern,
            bias: finalBias,
            confidence: top.confidence,
            candleProgress: Math.round(candleProgress * 100),
            note: candleProgress < 0.7 ?
                'Pattern still forming — final shape may change' :
                'Pattern near completion — high reliability'
        };
    }

    return { patterns: found, summary };
}

// Heuristic: estimate how far through the current candle we are.
// For real-time use: pass the current time + last candle's expected close time.
export function estimateCandleProgress(candle, tfMinutes) {
    if (!candle || !tfMinutes) return 0.5;
    const now = Date.now() / 1000;
    const candleStartUtc = candle.time;
    const expectedClose = candleStartUtc + tfMinutes * 60;
    if (now <= candleStartUtc) return 0;
    if (now >= expectedClose) return 1;
    return (now - candleStartUtc) / (expectedClose - candleStartUtc);
}

// ============================================================
//  ADDITIONAL PATTERNS — completed candle library
//  Used by scanAllCandles for historical chart annotation
// ============================================================

function detectHarami(prev, cur) {
    if (!prev || !cur) return null;
    const pBull = prev.close > prev.open;
    const cBull = cur.close > cur.open;
    if (pBull === cBull) return null;
    const cTop = Math.max(cur.open, cur.close);
    const cBot = Math.min(cur.open, cur.close);
    const pTop = Math.max(prev.open, prev.close);
    const pBot = Math.min(prev.open, prev.close);
    // Current body fully inside prior body
    if (cTop < pTop && cBot > pBot) return cBull ? 'BULL_HARAMI' : 'BEAR_HARAMI';
    return null;
}

function detectPiercingDarkCloud(prev, cur) {
    if (!prev || !cur) return null;
    const pBull = prev.close > prev.open;
    const cBull = cur.close > cur.open;
    const pBody = Math.abs(prev.close - prev.open);
    const cBody = Math.abs(cur.close - cur.open);
    if (cBody < pBody * 0.5) return null;
    // Piercing Line — bullish reversal: prev bear, cur bull opens below prev low, closes above midpoint of prev body
    if (!pBull && cBull && cur.open < prev.low && cur.close > (prev.open + prev.close) / 2 && cur.close < prev.open) {
        return 'PIERCING_LINE';
    }
    // Dark Cloud Cover — bearish reversal
    if (pBull && !cBull && cur.open > prev.high && cur.close < (prev.open + prev.close) / 2 && cur.close > prev.open) {
        return 'DARK_CLOUD';
    }
    return null;
}

function detectSpinningTop(s) {
    return s.bodyPct < 0.35 && s.upperWickPct > 0.3 && s.lowerWickPct > 0.3 && s.bodyPct > 0.05;
}

function detectHighWave(s) {
    return s.bodyPct < 0.2 && (s.upperWickPct + s.lowerWickPct) > 0.7;
}

function detectBeltHold(s, prev) {
    if (!prev) return null;
    // Bullish belt hold: opens at low (no lower wick), strong bull close
    if (s.bullish && s.lowerWickPct < 0.05 && s.bodyPct > 0.7) return 'BULL_BELT_HOLD';
    // Bearish belt hold: opens at high (no upper wick), strong bear close
    if (!s.bullish && s.upperWickPct < 0.05 && s.bodyPct > 0.7) return 'BEAR_BELT_HOLD';
    return null;
}

function detectKicker(prev, cur) {
    if (!prev || !cur) return null;
    const pBull = prev.close > prev.open;
    const cBull = cur.close > cur.open;
    if (pBull === cBull) return null;
    const pBodyPct = Math.abs(prev.close - prev.open) / (prev.high - prev.low || 1);
    const cBodyPct = Math.abs(cur.close - cur.open) / (cur.high - cur.low || 1);
    if (pBodyPct < 0.7 || cBodyPct < 0.7) return null;
    // Bull kicker: bearish marubozu followed by bullish marubozu with gap up open
    if (!pBull && cBull && cur.open > prev.open) return 'BULL_KICKER';
    if (pBull && !cBull && cur.open < prev.open) return 'BEAR_KICKER';
    return null;
}

function detectThreeInsideUpDown(prev2, prev1, cur) {
    if (!prev2 || !prev1 || !cur) return null;
    const h = detectHarami(prev2, prev1);
    if (!h) return null;
    const cBull = cur.close > cur.open;
    if (h === 'BULL_HARAMI' && cBull && cur.close > prev2.open) return 'THREE_INSIDE_UP';
    if (h === 'BEAR_HARAMI' && !cBull && cur.close < prev2.open) return 'THREE_INSIDE_DOWN';
    return null;
}

function detectRisingFallingThreeMethods(c1, c2, c3, c4, c5) {
    if (!c1 || !c2 || !c3 || !c4 || !c5) return null;
    const c1Bull = c1.close > c1.open;
    const c5Bull = c5.close > c5.open;
    const c1Body = Math.abs(c1.close - c1.open);
    const c5Body = Math.abs(c5.close - c5.open);
    const midBodies = [c2, c3, c4].map(c => Math.abs(c.close - c.open));
    const midSmall = midBodies.every(b => b < c1Body * 0.5);

    if (c1Bull && c5Bull && midSmall && c5.close > c1.close
        && [c2, c3, c4].every(c => c.close < c1.close && c.close > c1.open)) {
        return 'RISING_THREE_METHODS';
    }
    if (!c1Bull && !c5Bull && midSmall && c5.close < c1.close
        && [c2, c3, c4].every(c => c.close > c1.close && c.close < c1.open)) {
        return 'FALLING_THREE_METHODS';
    }
    return null;
}

// ============================================================
//  Full-series scan — finds every pattern across the candle array
//  Returns markers sorted by time for chart annotation.
//
//  Each marker: { time, type, bias, confidence, candleIdx, price }
// ============================================================
export function scanAllCandles(candles, opts = {}) {
    if (!candles || candles.length < 5) return [];
    const minConf = opts.minConf || 50;
    const lookbackBars = opts.lookbackBars || candles.length;
    const start = Math.max(4, candles.length - lookbackBars);
    const markers = [];

    // Pre-compute simple trend context windows for performance
    function trendAt(i) {
        if (i < 20) return 'unknown';
        const slope = (candles[i].close - candles[i - 20].close) / candles[i - 20].close;
        if (slope > 0.005) return 'uptrend';
        if (slope < -0.005) return 'downtrend';
        return 'sideways';
    }

    function emit(name, bias, candleIdx, baseShape, note, position = 'auto') {
        const ctx = trendAt(candleIdx);
        // Recalibrated: pure shape strength dominates; trend context is a modifier
        // not a gate. Strong patterns deserve to be seen even in sideways markets.
        const trendMatch =
            (bias === 'BULLISH' && ctx === 'downtrend') ? 1.10 :  // reversal at extreme
            (bias === 'BEARISH' && ctx === 'uptrend')   ? 1.10 :
            (bias === 'BULLISH' && ctx === 'uptrend')   ? 0.95 :  // continuation
            (bias === 'BEARISH' && ctx === 'downtrend') ? 0.95 :
            0.90;                                                  // sideways — almost neutral
        const conf = Math.min(99, Math.round(baseShape * trendMatch * 100));
        if (conf < minConf) return;
        const c = candles[candleIdx];
        const pos = position === 'auto' ? (bias === 'BULLISH' ? 'belowBar' : 'aboveBar') : position;
        markers.push({
            time: c.time,
            type: name, bias, confidence: conf,
            candleIdx, ctx, position: pos,
            price: bias === 'BULLISH' ? c.low : c.high,
            note
        });
    }

    for (let i = start; i < candles.length; i++) {
        const c = candles[i];
        const p1 = candles[i - 1];
        const p2 = candles[i - 2];
        const p3 = candles[i - 3];
        const p4 = candles[i - 4];
        const sCur = shapeOf(c);

        // ===== single candle =====
        if (detectHammer(sCur))         emit('Hammer', 'BULLISH', i, 0.85, 'Long lower wick');
        if (detectInverseHammer(sCur)) {
            const ctx = trendAt(i);
            if (ctx === 'downtrend') emit('Inverted Hammer', 'BULLISH', i, 0.7, 'Reversal probe');
            if (ctx === 'uptrend')   emit('Shooting Star', 'BEARISH', i, 0.85, 'Upper wick rejection');
        }
        if (detectDoji(sCur))           emit('Doji', 'NEUTRAL', i, 0.55, 'Indecision');
        if (detectMarubozu(sCur)) {
            emit(sCur.bullish ? 'Marubozu' : 'Marubozu',
                 sCur.bullish ? 'BULLISH' : 'BEARISH', i, 0.85, 'Full body');
        }
        if (detectSpinningTop(sCur))    emit('Spinning Top', 'NEUTRAL', i, 0.5, 'Indecision');
        if (detectHighWave(sCur))       emit('High Wave', 'NEUTRAL', i, 0.5, 'Extreme volatility');

        const belt = detectBeltHold(sCur, p1);
        if (belt) emit(belt === 'BULL_BELT_HOLD' ? 'Bull Belt Hold' : 'Bear Belt Hold',
                       belt === 'BULL_BELT_HOLD' ? 'BULLISH' : 'BEARISH', i, 0.78, 'Open at extreme + strong body');

        // ===== two candles =====
        const eng = detectEngulfing(p1, c);
        if (eng) emit(eng === 'BULL_ENGULF' ? 'Bull Engulfing' : 'Bear Engulfing',
                      eng === 'BULL_ENGULF' ? 'BULLISH' : 'BEARISH', i, 0.92, 'Body engulfs prior');

        const har = detectHarami(p1, c);
        if (har) emit(har === 'BULL_HARAMI' ? 'Bull Harami' : 'Bear Harami',
                      har === 'BULL_HARAMI' ? 'BULLISH' : 'BEARISH', i, 0.78, 'Body inside prior');

        const pdc = detectPiercingDarkCloud(p1, c);
        if (pdc === 'PIERCING_LINE') emit('Piercing Line', 'BULLISH', i, 0.85, 'Closes above midpoint');
        if (pdc === 'DARK_CLOUD')    emit('Dark Cloud', 'BEARISH', i, 0.85, 'Closes below midpoint');

        const tw = detectTweezer(p1, c);
        if (tw) emit(tw === 'TWEEZER_TOP' ? 'Tweezer Top' : 'Tweezer Bottom',
                     tw === 'TWEEZER_TOP' ? 'BEARISH' : 'BULLISH', i, 0.7, 'Level rejection');

        const io = detectInsideOutside(p1, c);
        if (io === 'INSIDE_BAR') emit('Inside Bar', 'NEUTRAL', i, 0.55, 'Compression');
        if (io === 'OUTSIDE_BAR') emit('Outside Bar', sCur.bullish ? 'BULLISH' : 'BEARISH', i, 0.75, 'Range expansion');

        const kicker = detectKicker(p1, c);
        if (kicker) emit(kicker === 'BULL_KICKER' ? 'Bull Kicker' : 'Bear Kicker',
                         kicker === 'BULL_KICKER' ? 'BULLISH' : 'BEARISH', i, 0.95, 'Gap reversal');

        // ===== three candles =====
        const star = detectStar(p2, p1, c);
        if (star) emit(star === 'MORNING_STAR' ? 'Morning Star' : 'Evening Star',
                       star === 'MORNING_STAR' ? 'BULLISH' : 'BEARISH', i, 0.92, '3-candle reversal');

        const trio = detectThreeIn(candles.slice(i - 2, i + 1));
        if (trio) emit(trio === 'THREE_SOLDIERS' ? 'Three Soldiers' : 'Three Crows',
                       trio === 'THREE_SOLDIERS' ? 'BULLISH' : 'BEARISH', i, 0.85, 'Sustained momentum');

        const threeIn = detectThreeInsideUpDown(p2, p1, c);
        if (threeIn) emit(threeIn === 'THREE_INSIDE_UP' ? 'Three Inside Up' : 'Three Inside Down',
                          threeIn === 'THREE_INSIDE_UP' ? 'BULLISH' : 'BEARISH', i, 0.82, 'Harami confirmation');

        // ===== five candles =====
        const rfm = detectRisingFallingThreeMethods(p4, p3, p2, p1, c);
        if (rfm) emit(rfm === 'RISING_THREE_METHODS' ? 'Rising 3 Methods' : 'Falling 3 Methods',
                      rfm === 'RISING_THREE_METHODS' ? 'BULLISH' : 'BEARISH', i, 0.88, 'Continuation pattern');
    }

    // Dedupe: keep only the highest-confidence pattern per (time, bias)
    const dedup = new Map();
    for (const m of markers) {
        const key = `${m.time}_${m.bias}`;
        const existing = dedup.get(key);
        if (!existing || existing.confidence < m.confidence) dedup.set(key, m);
    }
    return Array.from(dedup.values()).sort((a, b) => a.time - b.time);
}
