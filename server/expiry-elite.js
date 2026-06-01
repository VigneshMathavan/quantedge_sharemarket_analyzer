// server/expiry-elite.js — Institutional-grade expiry-day signal booster.
//
// On expiry day (DTE ≤ 1) the market is dominated by:
//   • MAX PAIN magnet — price gravitates to highest open-interest strike
//   • OI shift detection — large writers rolling = directional bias
//   • Theta crush — long options bleed fast → buy bias only with edge
//   • Gamma blast — ATM near expiry has explosive premium moves
//   • Final-hour acceleration — 14:00-15:15 IST has predictable patterns
//
// We compute these on top of the normal engine output and stamp signals
// with the ELITE tier when ≥3 of these institutional confirmations align.

import { daysToExpiry } from './greeks.js';

// ── 1. MAX PAIN — strike at which option writers (overall) lose least.
//      Spot tends to magnet here on expiry day.
function calculateMaxPain(chain) {
    if (!chain || !chain.length) return null;
    const strikes = [...new Set(chain.map(r => r.strike))].sort((a, b) => a - b);
    if (strikes.length < 5) return null;
    let minPain = Infinity, bestStrike = null;
    for (const sp of strikes) {
        let totalPain = 0;
        for (const r of chain) {
            if (r.type === 'CE' && sp > r.strike) totalPain += (sp - r.strike) * (r.oi || 0);
            if (r.type === 'PE' && sp < r.strike) totalPain += (r.strike - sp) * (r.oi || 0);
        }
        if (totalPain < minPain) { minPain = totalPain; bestStrike = sp; }
    }
    return bestStrike;
}

// ── 2. OI SHIFT — find strikes with biggest OI changes (writers/unwinders).
//      If big call writers added → expecting capping above. If unwinders → bullish.
function detectOIShift(chain) {
    if (!chain || !chain.length) return { topCallAdd: null, topPutAdd: null, topCallUnwind: null, topPutUnwind: null };
    const calls = chain.filter(r => r.type === 'CE' && r.oiChange !== undefined);
    const puts = chain.filter(r => r.type === 'PE' && r.oiChange !== undefined);
    calls.sort((a, b) => (b.oiChange || 0) - (a.oiChange || 0));
    puts.sort((a, b) => (b.oiChange || 0) - (a.oiChange || 0));
    return {
        topCallAdd:     calls[0],
        topCallUnwind:  calls[calls.length - 1],
        topPutAdd:      puts[0],
        topPutUnwind:   puts[puts.length - 1]
    };
}

// ── 3. THETA DIRECTION — on expiry day, buying options is hostile because
//      theta crushes ~50% by 14:30. Only "elite" buys when:
//        (a) deep ITM where intrinsic > theta loss, OR
//        (b) strong directional + gamma blast setup
function thetaPenalty(dte, isATM) {
    if (dte < 0.05) return 100;        // <1 hr to expiry → don't buy ATM
    if (dte < 0.15 && isATM) return 60; // <3 hr ATM → severe penalty
    if (dte < 0.3) return 30;
    return 0;
}

// ── 4. PCR — Put/Call ratio. > 1.2 = bullish (puts being written),
//      < 0.7 = bearish (calls being written aggressively)
function calculatePCR(chain) {
    if (!chain || !chain.length) return null;
    let callOI = 0, putOI = 0;
    for (const r of chain) {
        if (r.type === 'CE') callOI += r.oi || 0;
        else if (r.type === 'PE') putOI += r.oi || 0;
    }
    return callOI > 0 ? putOI / callOI : null;
}

// ── 5. FINAL-HOUR PATTERN BIAS
//      14:00-15:00 → trend-following gets best fills (institutions
//      flatten books; momentum acceleration). After 15:00 → mean reversion
//      as MM unwind.
function finalHourBias(candles) {
    if (!candles || candles.length < 5) return null;
    const last = candles[candles.length - 1];
    const ist = new Date((last.time + (5*60+30)*60) * 1000);
    const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (istMin >= 14*60 && istMin < 15*60) return 'MOMENTUM';
    if (istMin >= 15*60 && istMin <= 15*60+15) return 'MEAN_REVERT';
    return null;
}

// ── Main analyzer — called from confluence endpoint after we have
//    chain + side. Returns { tier, confirmations, notes, maxPain, pcr, etc. }
export function analyzeExpiryDay({ symbol, side, spot, chain, candles }) {
    const dte = daysToExpiry(symbol);
    const isExpiryWindow = dte <= 1.5;
    if (!isExpiryWindow || !chain || chain.length < 10) {
        return { isExpiry: false, tier: null };
    }

    const isCall = side === 'BUY_CALL';
    const maxPain = calculateMaxPain(chain);
    const oiShift = detectOIShift(chain);
    const pcr = calculatePCR(chain);
    const bias = finalHourBias(candles);
    const atmStrike = Math.round(spot / 50) * 50;
    const isATM = chain.some(r => r.strike === atmStrike);

    const confirmations = [];
    const warnings = [];

    // CONFIRMATION 1 — Max Pain magnet aligned with direction
    if (maxPain) {
        const distToMP = ((maxPain - spot) / spot) * 100;
        if (isCall && maxPain > spot) {
            confirmations.push(`Max Pain at ${maxPain} above spot (+${distToMP.toFixed(2)}%) — magnet supports CALL`);
        } else if (!isCall && maxPain < spot) {
            confirmations.push(`Max Pain at ${maxPain} below spot (${distToMP.toFixed(2)}%) — magnet supports PUT`);
        } else {
            warnings.push(`Max Pain at ${maxPain} works against ${isCall?'CALL':'PUT'} (price magneting opposite)`);
        }
    }

    // CONFIRMATION 2 — OI shift agrees with side
    if (oiShift.topCallAdd && oiShift.topPutAdd) {
        const callWriting = (oiShift.topCallAdd.oiChange || 0);
        const putWriting = (oiShift.topPutAdd.oiChange || 0);
        if (isCall && putWriting > callWriting * 1.3) {
            confirmations.push(`Strong put writing at ${oiShift.topPutAdd.strike} (+${(putWriting/1e5).toFixed(1)}L OI) — supports CALL`);
        } else if (!isCall && callWriting > putWriting * 1.3) {
            confirmations.push(`Strong call writing at ${oiShift.topCallAdd.strike} (+${(callWriting/1e5).toFixed(1)}L OI) — supports PUT`);
        }
    }

    // CONFIRMATION 3 — PCR direction
    if (pcr !== null) {
        if (isCall && pcr > 1.1) confirmations.push(`PCR ${pcr.toFixed(2)} (>1.1) — bullish bias supports CALL`);
        else if (!isCall && pcr < 0.85) confirmations.push(`PCR ${pcr.toFixed(2)} (<0.85) — bearish bias supports PUT`);
        else if (pcr > 1.3) warnings.push(`PCR ${pcr.toFixed(2)} extremely bullish — fading short ${isCall?'':'this PUT'} risky`);
    }

    // CONFIRMATION 4 — Time-of-day pattern
    if (bias === 'MOMENTUM') confirmations.push(`Final-hour momentum window (14:00-15:00 IST) — institutional acceleration`);
    if (bias === 'MEAN_REVERT') warnings.push(`Post-15:00 mean-reversion window — directional buys risky`);

    // CONFIRMATION 5 — Theta sanity (don't buy options too close to expiry)
    const thetaP = thetaPenalty(dte, isATM);
    if (thetaP === 0) {
        if (dte < 0.5) confirmations.push(`DTE ${dte.toFixed(2)}d — theta still manageable for momentum buys`);
    } else if (thetaP < 60) {
        warnings.push(`Theta drag ${thetaP}% — risk-reward stretched, prefer ITM-1`);
    } else {
        warnings.push(`Theta crush ${thetaP}% — DON'T buy ATM here, look for spreads or skip`);
    }

    // ── Final tier ──
    let tier = 'WATCH';      // not enough confirmations
    if (confirmations.length >= 3 && warnings.length <= 1) tier = 'ELITE';
    else if (confirmations.length >= 2) tier = 'STRONG';
    else if (confirmations.length >= 1) tier = 'OK';

    return {
        isExpiry: true,
        tier,
        confirmations,
        warnings,
        maxPain,
        pcr: pcr !== null ? parseFloat(pcr.toFixed(2)) : null,
        oiShift,
        bias,
        dte: parseFloat(dte.toFixed(2)),
        thetaPenalty: thetaP
    };
}
