// server/oi-flow.js
//
// OPTIONS OI FLOW ANALYTICS per the master spec.
//
//   "OI Build Up · Long Build Up · Short Build Up ·
//    Long Unwinding · Short Covering"
//
// Classifies the current ATM-vicinity OI shift into one of the four
// classic regimes using the broker chain's oiChange field (delta from
// previous snapshot, signed integer).
//
// Returns a structured verdict the confluence engine can consume.
//
//   • LONG_BUILDUP   price↑ + OI↑  → strong bullish conviction
//   • SHORT_BUILDUP  price↓ + OI↑  → strong bearish conviction
//   • LONG_UNWIND    price↓ + OI↓  → bulls exiting (weakening down)
//   • SHORT_COVER    price↑ + OI↓  → shorts capitulating (weakening up)
//
// All data sourced from broker chain — zero theoretical computation.

export function analyzeOIFlow({ chain, spot, priceDirection5m }) {
    if (!Array.isArray(chain) || chain.length === 0 || spot == null) {
        return { available: false };
    }

    // Look at ATM ± 3 strikes (the gravity zone for OI shifts)
    const allStrikes = [...new Set(chain.map(r => r.strike))].sort((a, b) => a - b);
    const atm = allStrikes.reduce((b, s) => Math.abs(s - spot) < Math.abs(b - spot) ? s : b, allStrikes[0]);
    const atmIdx = allStrikes.indexOf(atm);
    const nearby = allStrikes.slice(Math.max(0, atmIdx - 3), atmIdx + 4);

    let callOIChg = 0, putOIChg = 0;
    let callOIAbs = 0, putOIAbs = 0;

    for (const strike of nearby) {
        const ce = chain.find(r => r.strike === strike && r.type === 'CE');
        const pe = chain.find(r => r.strike === strike && r.type === 'PE');
        if (ce) { callOIChg += (ce.oiChange || 0); callOIAbs += (ce.oi || 0); }
        if (pe) { putOIChg += (pe.oiChange || 0); putOIAbs += (pe.oi || 0); }
    }

    // Buildup vs unwinding classification per side, then directional
    const callBuildup = callOIChg > 0;     // new call positions = bearish for CE writers, bullish for CE buyers
    const callUnwind = callOIChg < 0;
    const putBuildup = putOIChg > 0;
    const putUnwind = putOIChg < 0;

    // Net flow signal — combine price direction with OI shifts.
    // Convention: positive = bullish, negative = bearish.
    let verdict = 'NEUTRAL';
    let conviction = 'LOW';
    let reason = '';

    if (priceDirection5m > 0 && putBuildup && !callBuildup) {
        verdict = 'LONG_BUILDUP';
        conviction = 'HIGH';
        reason = `Price↑ + Put writing ↑${formatK(putOIChg)} (longs adding at ATM)`;
    } else if (priceDirection5m < 0 && callBuildup && !putBuildup) {
        verdict = 'SHORT_BUILDUP';
        conviction = 'HIGH';
        reason = `Price↓ + Call writing ↑${formatK(callOIChg)} (shorts adding at ATM)`;
    } else if (priceDirection5m < 0 && putUnwind) {
        verdict = 'LONG_UNWIND';
        conviction = 'MEDIUM';
        reason = `Price↓ + Put unwinding ${formatK(putOIChg)} (longs exiting — bears in control)`;
    } else if (priceDirection5m > 0 && callUnwind) {
        verdict = 'SHORT_COVER';
        conviction = 'MEDIUM';
        reason = `Price↑ + Call unwinding ${formatK(callOIChg)} (shorts covering — bulls reclaim)`;
    } else if (Math.abs(callOIChg) > Math.abs(putOIChg) * 1.5 && callBuildup) {
        verdict = 'CALL_WRITER_DOMINANT';
        conviction = 'LOW';
        reason = `Heavy call writing — resistance building at ATM (${formatK(callOIChg)} CE / ${formatK(putOIChg)} PE)`;
    } else if (Math.abs(putOIChg) > Math.abs(callOIChg) * 1.5 && putBuildup) {
        verdict = 'PUT_WRITER_DOMINANT';
        conviction = 'LOW';
        reason = `Heavy put writing — support forming at ATM (${formatK(putOIChg)} PE / ${formatK(callOIChg)} CE)`;
    }

    return {
        available: true,
        verdict,
        conviction,
        reason,
        atm,
        nearbyStrikes: nearby,
        callOIChange: callOIChg,
        putOIChange: putOIChg,
        callOITotal: callOIAbs,
        putOITotal: putOIAbs,
        netFlow: putOIChg - callOIChg,   // positive = put writers dominant (bullish)
        // Sides that this verdict supports (used by confluence engine)
        supportsCall: verdict === 'LONG_BUILDUP' || verdict === 'SHORT_COVER' || verdict === 'PUT_WRITER_DOMINANT',
        supportsPut:  verdict === 'SHORT_BUILDUP' || verdict === 'LONG_UNWIND' || verdict === 'CALL_WRITER_DOMINANT'
    };
}

function formatK(n) {
    if (n == null) return '0';
    const v = Math.round(n / 1000);
    return (v >= 0 ? '+' : '') + v + 'K';
}
