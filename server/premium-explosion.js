// server/premium-explosion.js — Priority 7: Premium Explosion Detector
//
// Predicts probability of a 30%+ premium move in the next 30-60 min
// based on:
//   • Delta acceleration (price velocity × delta)
//   • Gamma expansion (near ATM + low DTE → big leverage)
//   • OI velocity (sudden put-writing or call-buying)
//   • ATR expansion (volatility regime change)
//   • Volume explosion (>2.5× avg)
//   • Cross-index leadership confirmation
//
// Each contributor maps to a probability boost; final score is
// clamped 0-100. Goal: surface the 30%+ option moves BEFORE they
// happen, not after.

export function detectPremiumExplosion({ params, oiFlow, leadership, gammaBlast, side }) {
    if (!params) return { available: false };
    let prob = 30;        // baseline 30%
    const contributors = [];

    // 1. Delta acceleration — fast price move with high delta = big premium kick
    const ema9Slope = Math.abs(params.trend?.ema9Slope5Pct || 0);
    if (ema9Slope > 0.3) {
        const boost = Math.min(15, ema9Slope * 10);
        prob += boost;
        contributors.push({ name: 'Δ Acceleration', boost: parseFloat(boost.toFixed(1)),
            detail: `EMA9 slope ${ema9Slope.toFixed(2)}%` });
    }

    // 2. Gamma expansion — already-detected gamma blast
    if (gammaBlast?.detected) {
        const boost = gammaBlast.severity >= 70 ? 25 : 15;
        prob += boost;
        contributors.push({ name: 'Γ Expansion',
            boost, detail: `Gamma blast severity ${gammaBlast.severity}` });
    }

    // 3. OI velocity — strong directional buildup
    if (oiFlow?.available && oiFlow.conviction === 'HIGH') {
        const supports = (side === 'BUY_CALL' && oiFlow.supportsCall) ||
                         (side === 'BUY_PUT' && oiFlow.supportsPut);
        if (supports) {
            prob += 12;
            contributors.push({ name: 'OI Velocity',
                boost: 12, detail: oiFlow.verdict.replace(/_/g, ' ') });
        }
    }

    // 4. ATR expansion — vol regime opening up
    if (params.volatility?.atrState === 'EXPANDING') {
        prob += 8;
        contributors.push({ name: 'ATR Expansion',
            boost: 8, detail: `Ratio ${params.volatility.atrRatioVsPast}` });
    }

    // 5. Volume explosion
    const relVol = params.volume?.relativeVolume || 1;
    if (relVol >= 2.5) {
        const boost = Math.min(12, (relVol - 2) * 6);
        prob += boost;
        contributors.push({ name: 'Volume Spike',
            boost: parseFloat(boost.toFixed(1)), detail: `${relVol.toFixed(1)}× avg` });
    }

    // 6. Cross-index leadership confirmation
    if (leadership?.alignedWithLeader && leadership.confirmation === 'STRONG') {
        prob += 8;
        contributors.push({ name: 'Cross-Index Leader',
            boost: 8, detail: `${leadership.directionalLeader?.symbol} leading` });
    }

    // 7. SMC liquidity sweep — often precedes explosive moves
    const sweep = (side === 'BUY_CALL' && params.smc?.liquiditySweepBull) ||
                  (side === 'BUY_PUT' && params.smc?.liquiditySweepBear);
    if (sweep) {
        prob += 10;
        contributors.push({ name: 'Liquidity Sweep',
            boost: 10, detail: `${side === 'BUY_CALL' ? 'Bull' : 'Bear'} sweep detected` });
    }

    // 8. BOS confirmation
    const bos = (side === 'BUY_CALL' && params.structure?.bullBOS) ||
                (side === 'BUY_PUT' && params.structure?.bearBOS);
    if (bos) {
        prob += 8;
        contributors.push({ name: 'Break of Structure',
            boost: 8, detail: `${side === 'BUY_CALL' ? 'Bull' : 'Bear'} BOS` });
    }

    prob = Math.max(5, Math.min(95, prob));

    return {
        available: true,
        probability: parseFloat(prob.toFixed(1)),
        verdict: prob >= 75 ? 'EXPLOSION_LIKELY' :
                 prob >= 55 ? 'ELEVATED_RISK_REWARD' :
                 prob >= 40 ? 'STANDARD' : 'COMPRESSED',
        contributors,
        // Expected size if explosion fires (based on contributor count)
        expectedMagnitudePct: parseFloat((30 + contributors.length * 8).toFixed(0))
    };
}
