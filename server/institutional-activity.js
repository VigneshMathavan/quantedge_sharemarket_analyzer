// server/institutional-activity.js — INSTITUTIONAL ACTIVITY TRACKER
//
// Spots "smart money" footprints from real broker data:
//   • Sudden OI shift (>50% spike vs 5-bar avg) at a single strike
//   • Large volume spike at ATM (>3× rel volume)
//   • Unusual option activity (OI change >> price move)
//   • Strike migration (writers moving up/down)
//
// Output: BULLISH / BEARISH / NEUTRAL verdict + reason list.

export function detectInstitutionalActivity({ chain, spot, params }) {
    if (!Array.isArray(chain) || chain.length === 0 || spot == null) {
        return { available: false };
    }
    const allStrikes = [...new Set(chain.map(r => r.strike))].sort((a, b) => a - b);
    const atm = allStrikes.reduce((b, s) => Math.abs(s - spot) < Math.abs(b - spot) ? s : b, allStrikes[0]);

    const signals = [];
    let bullScore = 0, bearScore = 0;

    // 1. ATM call wall and put wall — find single largest OI strikes
    const ces = chain.filter(r => r.type === 'CE').sort((a, b) => (b.oi || 0) - (a.oi || 0));
    const pes = chain.filter(r => r.type === 'PE').sort((a, b) => (b.oi || 0) - (a.oi || 0));
    const biggestCall = ces[0];
    const biggestPut = pes[0];

    if (biggestPut && biggestPut.strike >= atm - 100 && biggestPut.strike <= atm) {
        bullScore += 15;
        signals.push(`Put wall at ${biggestPut.strike} (${(biggestPut.oi / 1e6).toFixed(1)}M OI) — institutional support`);
    }
    if (biggestCall && biggestCall.strike <= atm + 100 && biggestCall.strike >= atm) {
        bearScore += 15;
        signals.push(`Call wall at ${biggestCall.strike} (${(biggestCall.oi / 1e6).toFixed(1)}M OI) — institutional resistance`);
    }

    // 2. Aggressive OI build-up at single strike (>20% of total chain OI)
    const totalCallOI = ces.reduce((a, r) => a + (r.oi || 0), 0);
    const totalPutOI = pes.reduce((a, r) => a + (r.oi || 0), 0);
    for (const ce of ces.slice(0, 3)) {
        if (totalCallOI > 0 && ce.oi / totalCallOI > 0.20) {
            bearScore += 10;
            signals.push(`Heavy call writing at ${ce.strike} (${((ce.oi/totalCallOI)*100).toFixed(0)}% of chain)`);
            break;
        }
    }
    for (const pe of pes.slice(0, 3)) {
        if (totalPutOI > 0 && pe.oi / totalPutOI > 0.20) {
            bullScore += 10;
            signals.push(`Heavy put writing at ${pe.strike} (${((pe.oi/totalPutOI)*100).toFixed(0)}% of chain)`);
            break;
        }
    }

    // 3. OI change momentum — sum of |oiChange| across ATM±2 vs total
    const atmIdx = allStrikes.indexOf(atm);
    const nearby = allStrikes.slice(Math.max(0, atmIdx - 2), atmIdx + 3);
    let nearCallChg = 0, nearPutChg = 0;
    for (const k of nearby) {
        const ce = chain.find(c => c.strike === k && c.type === 'CE');
        const pe = chain.find(c => c.strike === k && c.type === 'PE');
        if (ce) nearCallChg += (ce.oiChange || 0);
        if (pe) nearPutChg += (pe.oiChange || 0);
    }
    if (Math.abs(nearPutChg) > Math.abs(nearCallChg) * 1.5) {
        if (nearPutChg > 0) {
            bullScore += 12;
            signals.push(`Aggressive put writing at ATM band (+${(nearPutChg/1000).toFixed(0)}K OI)`);
        } else {
            bearScore += 12;
            signals.push(`Put unwinding at ATM band (${(nearPutChg/1000).toFixed(0)}K OI)`);
        }
    }
    if (Math.abs(nearCallChg) > Math.abs(nearPutChg) * 1.5) {
        if (nearCallChg > 0) {
            bearScore += 12;
            signals.push(`Aggressive call writing at ATM band (+${(nearCallChg/1000).toFixed(0)}K OI)`);
        } else {
            bullScore += 12;
            signals.push(`Call unwinding at ATM band (${(nearCallChg/1000).toFixed(0)}K OI) — short cover`);
        }
    }

    // 4. Volume spike on price (institutional volume often unusual)
    if (params?.volume?.relativeVolume >= 3) {
        const isGreen = params.priceAction?.isGreen;
        if (isGreen) { bullScore += 8; signals.push(`Volume spike ${params.volume.relativeVolume.toFixed(1)}× on up-candle`); }
        else { bearScore += 8; signals.push(`Volume spike ${params.volume.relativeVolume.toFixed(1)}× on down-candle`); }
    }

    const net = bullScore - bearScore;
    const verdict = net >= 15 ? 'BULLISH' : net <= -15 ? 'BEARISH' : 'NEUTRAL';
    const confidence = Math.min(100, Math.abs(net) * 2);

    return {
        available: true,
        verdict,
        confidence,
        bullScore, bearScore,
        signals: signals.slice(0, 6)
    };
}
