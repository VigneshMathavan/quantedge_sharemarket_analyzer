// server/cpr.js — Central Pivot Range (CPR) + Pivot Points
//
// CPR is the floor-trader's daily pivot trio. For session [PrevH, PrevL, PrevC]:
//   Pivot (P) = (H + L + C) / 3
//   BC        = (H + L) / 2
//   TC        = 2*P - BC
//
// Day classification:
//   - NARROW CPR  (width < 0.2% of close) → high probability of TRENDING day
//   - WIDE CPR    (width > 0.5% of close) → range / consolidation day
//   - MEDIUM      → mixed
//
// Standard pivot levels: R1, R2, R3, S1, S2, S3 also computed.
//
// Plus: 2-day and weekly CPR for confluence with daily.

export function computeCPR(prevDayCandle) {
    if (!prevDayCandle) return null;
    const { high: H, low: L, close: C } = prevDayCandle;
    const P  = (H + L + C) / 3;
    const BC = (H + L) / 2;
    const TC = 2 * P - BC;
    const top = Math.max(TC, BC);
    const bot = Math.min(TC, BC);
    const width = top - bot;
    const widthPct = (width / C) * 100;

    // Floor pivots (Classic R/S)
    const R1 = 2 * P - L;
    const R2 = P + (H - L);
    const R3 = H + 2 * (P - L);
    const S1 = 2 * P - H;
    const S2 = P - (H - L);
    const S3 = L - 2 * (H - P);

    // Day type
    let dayType = 'MEDIUM';
    if (widthPct < 0.20) dayType = 'NARROW';      // trending day expected
    else if (widthPct > 0.50) dayType = 'WIDE';   // range day expected

    return { pivot: P, TC, BC, top, bot, width, widthPct,
             R1, R2, R3, S1, S2, S3, dayType, ref: { H, L, C } };
}

// Roll up a series of minute/hour candles into one "session" candle.
function sessionCandle(candles, startUnix, endUnix) {
    const slice = candles.filter(c => c.time >= startUnix && c.time < endUnix);
    if (!slice.length) return null;
    return {
        time: startUnix,
        open: slice[0].open,
        high: Math.max(...slice.map(c => c.high)),
        low:  Math.min(...slice.map(c => c.low)),
        close: slice[slice.length - 1].close,
        volume: slice.reduce((s, c) => s + (c.volume || 0), 0)
    };
}

// Compute prev-day, prev-week, and 2-day CPR from a candle series.
// Candles must include the current day plus history.
export function computeAllCPR(candles) {
    if (!candles || candles.length < 50) return null;
    const last = candles[candles.length - 1];
    const istOff = (5 * 60 + 30) * 60;  // seconds

    // Compute session boundaries (00:00 IST → 23:59:59 IST per "day")
    const istLastDay = new Date((last.time + istOff) * 1000);
    istLastDay.setUTCHours(0, 0, 0, 0);
    const todayStart = istLastDay.getTime() / 1000 - istOff;  // back to unix UTC

    // Yesterday: today - 24h. But we need the previous TRADING day, so step
    // back day-by-day until we find candles.
    let prevDay = null;
    for (let dayBack = 1; dayBack <= 7 && !prevDay; dayBack++) {
        const s = todayStart - dayBack * 86400;
        const e = todayStart - (dayBack - 1) * 86400;
        const c = sessionCandle(candles, s, e);
        if (c) prevDay = c;
    }

    // Previous week (Monday 00:00 → Friday 16:00 IST)
    const dow = new Date(todayStart * 1000 + istOff * 1000).getUTCDay();  // 0=Sun
    const daysToMonday = (dow === 0 ? 7 : dow - 1);
    const thisMondayStart = todayStart - daysToMonday * 86400;
    const prevWeekStart = thisMondayStart - 7 * 86400;
    const prevWeekEnd = thisMondayStart;
    const prevWeek = sessionCandle(candles, prevWeekStart, prevWeekEnd);

    return {
        daily:  prevDay ? computeCPR(prevDay) : null,
        weekly: prevWeek ? computeCPR(prevWeek) : null,
        prevDay, prevWeek
    };
}

// Strategy: CPR Breakout
//   • Long when price breaks above TC of a NARROW CPR with momentum candle
//   • Short when price breaks below BC of a NARROW CPR with momentum candle
export function evaluateCprBreakout({ candles, allCpr }) {
    if (!candles?.length || !allCpr?.daily) {
        return { fired: false, reason: 'no CPR data' };
    }
    const last = candles[candles.length - 1];
    const cpr = allCpr.daily;
    const isNarrow = cpr.dayType === 'NARROW';
    if (!isNarrow) return { fired: false, reason: `CPR ${cpr.dayType}, breakout strategy wants NARROW` };

    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low || 1;
    const bodyRatio = body / range;
    if (bodyRatio < 0.5) return { fired: false, reason: 'last candle indecisive (body/range < 0.5)' };

    // Bull breakout
    if (last.close > cpr.top && last.open < cpr.top + (cpr.top - cpr.bot) * 0.3) {
        return {
            fired: true,
            side: 'BUY_CALL',
            id: 'cpr_breakout',
            name: 'CPR Breakout (bull)',
            score: 30 + Math.min(20, bodyRatio * 30),
            reason: `Breakout above narrow CPR top (${cpr.top.toFixed(2)}) with body/range ${(bodyRatio*100).toFixed(0)}%`,
            stop: cpr.bot,
            target1: cpr.top + (cpr.top - cpr.bot) * 2,
            target2: cpr.R2
        };
    }
    // Bear breakout
    if (last.close < cpr.bot && last.open > cpr.bot - (cpr.top - cpr.bot) * 0.3) {
        return {
            fired: true,
            side: 'BUY_PUT',
            id: 'cpr_breakout',
            name: 'CPR Breakout (bear)',
            score: 30 + Math.min(20, bodyRatio * 30),
            reason: `Breakdown below narrow CPR bottom (${cpr.bot.toFixed(2)}) with body/range ${(bodyRatio*100).toFixed(0)}%`,
            stop: cpr.top,
            target1: cpr.bot - (cpr.top - cpr.bot) * 2,
            target2: cpr.S2
        };
    }
    return { fired: false, reason: 'price still inside CPR' };
}

// Strategy: CPR Reversal
//   • Long when price tests BC of a WIDE CPR from below + rejection candle
//   • Short when price tests TC of a WIDE CPR from above + rejection candle
export function evaluateCprReversal({ candles, allCpr }) {
    if (!candles?.length || !allCpr?.daily) {
        return { fired: false, reason: 'no CPR data' };
    }
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const cpr = allCpr.daily;
    if (cpr.dayType !== 'WIDE') return { fired: false, reason: `CPR ${cpr.dayType}, reversal strategy wants WIDE` };

    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low || 1;

    // Bullish reversal at BC (lower wick rejection)
    if (last.low <= cpr.bot && last.close > cpr.bot && lowerWick / range > 0.4) {
        return {
            fired: true,
            side: 'BUY_CALL',
            id: 'cpr_reversal',
            name: 'CPR Reversal (long at BC)',
            score: 28 + Math.min(18, (lowerWick / range) * 25),
            reason: `Bullish rejection wick at CPR bottom ${cpr.bot.toFixed(2)} (wick ${(lowerWick/range*100).toFixed(0)}%)`,
            stop: cpr.bot - (cpr.top - cpr.bot) * 0.5,
            target1: cpr.top,
            target2: cpr.R1
        };
    }
    // Bearish reversal at TC (upper wick rejection)
    if (last.high >= cpr.top && last.close < cpr.top && upperWick / range > 0.4) {
        return {
            fired: true,
            side: 'BUY_PUT',
            id: 'cpr_reversal',
            name: 'CPR Reversal (short at TC)',
            score: 28 + Math.min(18, (upperWick / range) * 25),
            reason: `Bearish rejection wick at CPR top ${cpr.top.toFixed(2)} (wick ${(upperWick/range*100).toFixed(0)}%)`,
            stop: cpr.top + (cpr.top - cpr.bot) * 0.5,
            target1: cpr.bot,
            target2: cpr.S1
        };
    }
    return { fired: false, reason: 'no rejection wick at CPR boundary' };
}

// Distance from current price to each CPR / pivot level — useful for the UI
export function cprProximity(spot, cpr) {
    if (!cpr || !spot) return null;
    const levels = {
        R3: cpr.R3, R2: cpr.R2, R1: cpr.R1,
        TC: cpr.TC, P: cpr.pivot, BC: cpr.BC,
        S1: cpr.S1, S2: cpr.S2, S3: cpr.S3
    };
    const sorted = Object.entries(levels)
        .map(([name, price]) => ({ name, price, distPct: ((price - spot) / spot) * 100 }))
        .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
    return { nearest: sorted[0], allLevels: sorted };
}
