// server/narrative-engine.js — AI MARKET NARRATIVE
//
// Translates the numeric intelligence into a plain-English story so
// users instantly understand WHY the signal fired, no scrolling
// through 12 panels of numbers required.
//
// All sentences are template-filled from the existing parameter /
// regime / OI / IV / leadership outputs — no LLM call, no API cost,
// deterministic.

export function buildNarrative({
    side, symbol, params, regime, oiFlow, ivForecast,
    leadership, premiumExplosion, expectedMove, signalQuality, similarity
}) {
    const isCall = side === 'BUY_CALL';
    const dir = isCall ? 'bullish' : 'bearish';
    const verb = isCall ? 'up' : 'down';
    const lines = [];

    // Headline
    const grade = signalQuality?.grade || 'C';
    lines.push(`**${symbol} ${dir} setup · Grade ${grade}**`);

    // Supporting factors (collect 3-5 strongest)
    const supports = [];
    if (params?.trend?.adx >= 25) supports.push(`Strong trend (ADX ${params.trend.adx.toFixed(0)})`);
    if (params?.trend?.stackAlignment) {
        const align = params.trend.stackAlignment;
        if ((isCall && align > 0.6) || (!isCall && align < -0.6)) {
            supports.push(`Perfect EMA stack ${isCall ? 'bull' : 'bear'} (9>20>50>100>200)`);
        }
    }
    if (params?.vwap?.aboveVWAP === isCall) supports.push(`Price ${isCall ? 'above' : 'below'} VWAP`);
    if (params?.volume?.relativeVolume >= 1.5) supports.push(`Volume ${params.volume.relativeVolume.toFixed(1)}× average`);
    if (oiFlow?.available && oiFlow.conviction !== 'LOW') {
        supports.push(`OI flow: ${oiFlow.verdict.replace(/_/g, ' ').toLowerCase()}`);
    }
    if (params?.structure) {
        if (isCall && params.structure.bullBOS) supports.push('Bullish break of structure');
        if (!isCall && params.structure.bearBOS) supports.push('Bearish break of structure');
    }
    if (params?.smc) {
        if (isCall && params.smc.liquiditySweepBull) supports.push('Bullish liquidity sweep (smart money entry)');
        if (!isCall && params.smc.liquiditySweepBear) supports.push('Bearish liquidity sweep (smart money entry)');
    }
    if (leadership?.confirmation === 'STRONG' && leadership.alignedWithLeader) {
        supports.push(`${leadership.directionalLeader.symbol} leading the move (confirmed)`);
    }
    if (ivForecast?.verdict === 'IV_EXPANSION_LIKELY') {
        supports.push(`IV expansion likely (+${ivForecast.expectedPremiumImpactPct}% premium kick expected)`);
    }
    if (premiumExplosion?.verdict === 'EXPLOSION_LIKELY') {
        supports.push(`Premium explosion ${premiumExplosion.probability}% likely (${premiumExplosion.expectedMagnitudePct}%+ move)`);
    }

    if (supports.length) {
        lines.push('');
        lines.push('**Supported by:**');
        for (const s of supports.slice(0, 6)) lines.push(`• ${s}`);
    }

    // Historical evidence
    if (similarity?.matchesWithOutcomes >= 5) {
        lines.push('');
        lines.push(`**Historical evidence:** ${similarity.matchesWithOutcomes} similar setups · ${similarity.winRate}% win rate · avg P&L ${similarity.avgPnl >= 0 ? '+' : ''}₹${similarity.avgPnl}`);
    }

    // Expected move
    if (expectedMove?.available) {
        lines.push(`**Expected move:** ${expectedMove.movePct.average >= 0 ? '+' : ''}${expectedMove.movePct.average}% over ~${expectedMove.avgDurationMin || '?'} min · ${expectedMove.winRate}% historical win rate`);
    }

    // Risks (failure reasons)
    if (signalQuality?.failureReasons?.length) {
        lines.push('');
        lines.push('**Risks to monitor:**');
        for (const r of signalQuality.failureReasons.slice(0, 3)) lines.push(`• ${r}`);
        if (signalQuality.failureProbability) {
            lines.push(`Failure probability: ${signalQuality.failureProbability}%`);
        }
    }

    return {
        markdown: lines.join('\n'),
        oneLiner: `${symbol} ${dir} · Grade ${grade}${supports.length ? ' · ' + supports[0] : ''}`,
        supportCount: supports.length
    };
}
