// server/chain-snapshot.js
//
// Compute a compact "chain context" object attached to every actionable
// signal so the UI shows the live broker chain state the signal fired in.
// No theoretical computation — all values come from broker chain rows.

export function buildChainSnapshot(chain, spot) {
    if (!Array.isArray(chain) || chain.length === 0) return null;

    const ces = chain.filter(r => r.type === 'CE');
    const pes = chain.filter(r => r.type === 'PE');
    if (!ces.length || !pes.length) return null;

    // ATM = strike with smallest |strike - spot|
    const allStrikes = [...new Set(chain.map(r => r.strike))].sort((a, b) => a - b);
    const atm = allStrikes.reduce((best, s) =>
        Math.abs(s - spot) < Math.abs(best - spot) ? s : best, allStrikes[0]);

    // PCR — total put OI / total call OI
    const totalCallOI = ces.reduce((a, r) => a + (r.oi || 0), 0);
    const totalPutOI  = pes.reduce((a, r) => a + (r.oi || 0), 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    // Max Pain — strike where total writer loss (calls + puts) is minimum.
    // For each strike S: loss = sum_{K<S}(S-K)*CallOI(K) + sum_{K>S}(K-S)*PutOI(K)
    let minLoss = Infinity, maxPainStrike = atm;
    for (const S of allStrikes) {
        let loss = 0;
        for (const r of ces) if (r.strike < S) loss += (S - r.strike) * (r.oi || 0);
        for (const r of pes) if (r.strike > S) loss += (r.strike - S) * (r.oi || 0);
        if (loss < minLoss) { minLoss = loss; maxPainStrike = S; }
    }

    // Highest OI strikes — call wall (resistance) + put wall (support)
    const callWall = [...ces].sort((a, b) => (b.oi || 0) - (a.oi || 0))[0];
    const putWall  = [...pes].sort((a, b) => (b.oi || 0) - (a.oi || 0))[0];

    // Near-strike LTPs — ATM ± 2 for quick reference
    const nearby = [];
    for (let i = -2; i <= 2; i++) {
        const k = allStrikes.indexOf(atm);
        const idx = k + i;
        if (idx < 0 || idx >= allStrikes.length) continue;
        const strike = allStrikes[idx];
        const ce = ces.find(r => r.strike === strike);
        const pe = pes.find(r => r.strike === strike);
        nearby.push({
            strike,
            ce: ce ? { ltp: ce.ltp, oi: ce.oi, iv: ce.iv, delta: ce.delta } : null,
            pe: pe ? { ltp: pe.ltp, oi: pe.oi, iv: pe.iv, delta: pe.delta } : null,
            isAtm: strike === atm
        });
    }

    return {
        capturedAt: Date.now(),
        spot,
        atm,
        expiry: chain[0]?.expiry || null,
        pcr: pcr != null ? parseFloat(pcr.toFixed(3)) : null,
        maxPain: maxPainStrike,
        callWall: callWall ? { strike: callWall.strike, oi: callWall.oi } : null,
        putWall:  putWall  ? { strike: putWall.strike,  oi: putWall.oi  } : null,
        totalCallOI,
        totalPutOI,
        nearby,
        source: 'broker'    // always — we never embed synthetic chain data
    };
}
