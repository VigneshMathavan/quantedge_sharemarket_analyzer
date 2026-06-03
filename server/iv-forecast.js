// server/iv-forecast.js — Priority 6: IV Expansion Forecast
//
// Forecasts whether implied vol is more likely to EXPAND or COMPRESS
// over the next session, and estimates the premium impact.
//
// Inputs: current ATM IV (from chain), realized vol (from candles),
// ATR state, and event calendar (RBI/FOMC/CPI nearby).
//
// Logic:
//   • IV << HV  → expansion likely (vol gets re-priced up)
//   • IV >> HV  → compression likely (vol crush)
//   • Event today/tomorrow → expansion bias
//   • ATR expanding → already-expanded state, less room to grow
//
// Output: probability + expected premium delta %.

export function forecastIV({ params, chain, eventGate }) {
    if (!params?.chain || !params?.volatility) {
        return { available: false };
    }
    const atmIV = params.chain.atmIV || 0;          // % (broker scale)
    const hv = params.volatility.historicalVolPct || 0;  // % annualized
    const atrRatio = params.volatility.atrRatioVsPast || 1;
    const inSqueeze = params.volatility.inSqueeze;

    // IV/HV ratio — values <0.85 = IV cheap (likely to expand)
    //                values >1.15 = IV rich (likely to compress)
    const ivHvRatio = hv > 0 ? atmIV / hv : 1;

    // Event boost — major events ahead increase IV expansion odds
    const eventBoost = eventGate?.hasMajor ? 0.25 :
                       eventGate?.hasMinor ? 0.10 : 0;

    // Squeeze state — BB squeeze typically resolves with vol expansion
    const squeezeBoost = inSqueeze ? 0.15 : 0;

    // ATR state — if already expanded, less likely to expand further
    const atrPenalty = atrRatio >= 1.5 ? -0.15 : 0;

    // Base probability from IV/HV
    let expandProb = 0.50;
    if (ivHvRatio < 0.7) expandProb = 0.80;
    else if (ivHvRatio < 0.85) expandProb = 0.65;
    else if (ivHvRatio < 1.15) expandProb = 0.50;
    else if (ivHvRatio < 1.30) expandProb = 0.35;
    else expandProb = 0.20;

    expandProb = Math.max(0.05, Math.min(0.95, expandProb + eventBoost + squeezeBoost + atrPenalty));
    const compressProb = 1 - expandProb;

    // Expected premium expansion (rule of thumb: a 10-pt IV bump on a
    // ₹50 ATM option ≈ 18-22% premium gain; we scale conservatively)
    const expectedIVDelta = expandProb >= 0.65 ? (8 + eventBoost * 30 + squeezeBoost * 20) :
                             expandProb <= 0.35 ? -(6 + atrPenalty * 30) : 0;
    const premiumImpactPct = expectedIVDelta * 1.8;   // approx vega leverage

    return {
        available: true,
        atmIV: parseFloat(atmIV.toFixed(2)),
        historicalVol: parseFloat(hv.toFixed(2)),
        ivHvRatio: parseFloat(ivHvRatio.toFixed(2)),
        expansionProbability: parseFloat((expandProb * 100).toFixed(1)),
        compressionProbability: parseFloat((compressProb * 100).toFixed(1)),
        expectedIVDeltaPts: parseFloat(expectedIVDelta.toFixed(1)),
        expectedPremiumImpactPct: parseFloat(premiumImpactPct.toFixed(1)),
        contributors: {
            ivCheap: ivHvRatio < 0.85,
            eventNear: !!(eventGate?.hasMajor || eventGate?.hasMinor),
            squeezePresent: !!inSqueeze,
            atrAlreadyExpanded: atrRatio >= 1.5
        },
        verdict: expandProb >= 0.70 ? 'IV_EXPANSION_LIKELY' :
                 expandProb <= 0.30 ? 'IV_COMPRESSION_LIKELY' : 'IV_NEUTRAL'
    };
}
