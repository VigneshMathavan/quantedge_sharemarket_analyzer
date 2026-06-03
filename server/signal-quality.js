// server/signal-quality.js — Priority 14 + 10
//
// 14: SIGNAL QUALITY SCORE — final A+ to D grade per master spec.
//     Weighted aggregate of every intelligence layer.
//
// 10: SIGNAL FAILURE PREDICTOR — flags reasons this signal may fail.
//     Each weak component contributes to failure probability + a
//     human-readable reason.

const WEIGHTS = {
    strategy:      0.20,   // raw confluence score
    historical:    0.15,   // similarity match win rate
    regime:        0.15,   // regime alignment + ADX
    volume:        0.10,   // relative volume + cumulative delta
    oi:            0.10,   // OI flow conviction
    iv:            0.10,   // IV forecast verdict
    breadth:       0.05,   // (sectorParticipation when available)
    sector:        0.05,   // (sectorStrength when available)
    crossIndex:    0.05,   // cross-index leader confirmation
    smc:           0.05    // structure / FVG / sweep
};

export function computeSignalQuality({
    confluenceScore, factorScores, similarity, mtfAlignment,
    oiFlow, ivForecast, premiumExplosion, leadership, params
}) {
    const components = {};

    // 1. Strategy quality — from raw confluence + MTF alignment
    components.strategy = Math.min(100, (confluenceScore || 0) +
        (mtfAlignment?.alignmentPct >= 70 ? 15 : mtfAlignment?.alignmentPct >= 50 ? 5 : -10));

    // 2. Historical evidence
    if (similarity?.matchesWithOutcomes >= 5) {
        components.historical = similarity.winRate >= 65 ? 90 :
                                similarity.winRate >= 55 ? 75 :
                                similarity.winRate >= 45 ? 55 : 30;
    } else {
        components.historical = 50;   // insufficient evidence — neutral
    }

    // 3. Regime
    components.regime = factorScores?.structure || 50;

    // 4. Volume
    components.volume = factorScores?.volume || 50;

    // 5. OI flow
    if (oiFlow?.available) {
        components.oi = oiFlow.conviction === 'HIGH' ? 85 :
                       oiFlow.conviction === 'MEDIUM' ? 65 : 45;
    } else {
        components.oi = 50;
    }

    // 6. IV forecast
    if (ivForecast?.available) {
        components.iv = ivForecast.verdict === 'IV_EXPANSION_LIKELY' ? 85 :
                       ivForecast.verdict === 'IV_NEUTRAL' ? 55 : 25;
    } else {
        components.iv = 50;
    }

    // 7. Breadth + 8. Sector — placeholders (need NSE breadth API)
    components.breadth = 50;
    components.sector = 50;

    // 9. Cross-index leadership
    if (leadership?.confirmation === 'STRONG') components.crossIndex = 85;
    else if (leadership?.confirmation === 'NEUTRAL') components.crossIndex = 55;
    else components.crossIndex = 25;

    // 10. SMC
    components.smc = factorScores?.smc || 50;

    // Weighted final
    let final = 0, totalW = 0;
    for (const [k, score] of Object.entries(components)) {
        const w = WEIGHTS[k] || 0;
        final += score * w;
        totalW += w;
    }
    final = Math.round(final / totalW);

    let grade;
    if (final >= 90) grade = 'A+';
    else if (final >= 80) grade = 'A';
    else if (final >= 70) grade = 'B';
    else if (final >= 60) grade = 'C';
    else if (final >= 50) grade = 'D';
    else grade = 'F';

    // ---------- Failure Predictor (Priority 10) ----------
    const failureReasons = [];
    if (components.volume < 50) failureReasons.push({ reason: 'Weak volume', severity: (50 - components.volume) });
    if (components.regime < 50) failureReasons.push({ reason: 'Regime mismatch', severity: (50 - components.regime) });
    if (components.oi < 50)     failureReasons.push({ reason: 'Conflicting OI flow', severity: (50 - components.oi) });
    if (components.iv < 40)     failureReasons.push({ reason: 'IV compression risk', severity: (40 - components.iv) });
    if (components.crossIndex < 40) failureReasons.push({ reason: 'Lagging cross-index', severity: (40 - components.crossIndex) });
    if (components.historical < 50) failureReasons.push({ reason: 'Poor historical analog', severity: (50 - components.historical) });
    if ((mtfAlignment?.alignmentPct || 0) < 50) failureReasons.push({ reason: 'MTF disagreement', severity: 50 - (mtfAlignment?.alignmentPct || 0) });
    if (premiumExplosion?.available && premiumExplosion.probability < 30) failureReasons.push({ reason: 'Low explosion probability', severity: 30 - premiumExplosion.probability });

    // Failure probability = sum of severities, normalized, clamped
    const rawFailure = failureReasons.reduce((s, r) => s + r.severity, 0);
    const failureProbability = Math.max(5, Math.min(95, Math.round(rawFailure / 3)));

    failureReasons.sort((a, b) => b.severity - a.severity);

    return {
        finalScore: final,
        grade,
        components,
        failureProbability,
        failureReasons: failureReasons.slice(0, 5).map(r => r.reason)
    };
}
