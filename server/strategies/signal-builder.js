// server/strategies/signal-builder.js — Turns an orchestrator verdict into a
// FULL actionable signal with SL, TP1, TP2, strike, premium levels, lots.
//
// Why this exists: the orchestrator only outputs "BUY_CALL / score 50%".
// A real trader needs: which strike, what's the entry, what's the stop, what
// are the targets, how many lots, max loss in ₹. This module computes that
// from the current spot + ATR + option chain.

import { atr } from '../signal2.js';

const SYMBOL_META = {
    NIFTY:     { lot_size: 25, strike_gap: 50 },
    SENSEX:    { lot_size: 10, strike_gap: 100 },
    FINNIFTY:  { lot_size: 25, strike_gap: 50 },
    BANKNIFTY: { lot_size: 15, strike_gap: 100 }
};

// Heuristic delta lookup by strike offset from ATM
function deltaForOffset(offset) {
    const map = { '-2': 0.72, '-1': 0.60, '0': 0.50, '1': 0.38, '2': 0.26 };
    return map[String(offset)] || 0.50;
}

// Pick the best strike given side + spot + chain + tier
function selectStrike({ side, spot, chain, tier, symbol }) {
    const meta = SYMBOL_META[symbol] || { strike_gap: 50 };
    const right = side === 'BUY_CALL' ? 'CE' : 'PE';
    const candidates = chain && chain.length
        ? chain.filter(o => o.type === right && o.oi > 50000 && o.ltp > 5)
        : [];

    // No real chain → synthesize ATM
    if (candidates.length === 0) {
        const atm = Math.round(spot / meta.strike_gap) * meta.strike_gap;
        // Synthetic premium estimate
        const intrinsic = side === 'BUY_CALL'
            ? Math.max(0, spot - atm)
            : Math.max(0, atm - spot);
        const timeValue = Math.max(40, spot * 0.005);
        return {
            strike: atm,
            right,
            offset: 0,
            premium: parseFloat((intrinsic + timeValue).toFixed(2)),
            delta: 0.50,
            iv: 14,
            oi: 0,
            source: 'synthetic'
        };
    }

    // Find ATM
    const atmStrike = candidates.reduce((best, o) =>
        Math.abs(o.strike - spot) < Math.abs(best.strike - spot) ? o : best
    , candidates[0]).strike;

    const allStrikes = [...new Set(candidates.map(c => c.strike))].sort((a, b) => a - b);
    const atmIdx = allStrikes.indexOf(atmStrike);

    // High-conviction → ATM (best delta/theta balance)
    // Medium → ATM
    // Low → ITM-1 for cushion (higher delta, less theta risk)
    let offset = 0;
    if (tier === 'C' || (tier === 'B' && Math.random() < 0.5)) offset = -1;  // ITM-1

    const targetStrike = side === 'BUY_CALL' ? allStrikes[atmIdx + offset] : allStrikes[atmIdx - offset];
    const final = candidates.find(c => c.strike === targetStrike) || candidates.find(c => c.strike === atmStrike);

    return {
        strike: final.strike,
        right,
        offset,
        premium: final.ltp,
        delta: deltaForOffset(offset),
        iv: final.iv,
        oi: final.oi,
        source: 'live'
    };
}

// Compute SL/T1/T2 from ATR
function computeLevels({ side, spot, atrV, delta, premium }) {
    // Spot levels
    const slDist = Math.max(atrV * 1.3, spot * 0.0025);
    const spotSL = side === 'BUY_CALL' ? spot - slDist : spot + slDist;
    const spotT1 = side === 'BUY_CALL' ? spot + slDist * 1.5 : spot - slDist * 1.5;
    const spotT2 = side === 'BUY_CALL' ? spot + slDist * 3.0 : spot - slDist * 3.0;

    // Premium levels via delta — capped at 50% premium SL
    const premSL = Math.max(premium * 0.5, premium - slDist * delta);
    const premT1 = premium + Math.abs(spotT1 - spot) * delta;
    const premT2 = premium + Math.abs(spotT2 - spot) * delta;

    return {
        spot: {
            entry: parseFloat(spot.toFixed(2)),
            stopLoss: parseFloat(spotSL.toFixed(2)),
            target1: parseFloat(spotT1.toFixed(2)),
            target2: parseFloat(spotT2.toFixed(2))
        },
        premium: {
            entry: parseFloat(premium.toFixed(2)),
            stopLoss: parseFloat(premSL.toFixed(2)),
            target1: parseFloat(premT1.toFixed(2)),
            target2: parseFloat(premT2.toFixed(2))
        },
        riskReward: parseFloat(((premT1 - premium) / Math.max(0.01, premium - premSL)).toFixed(2))
    };
}

function computeSizing({ accountSize, riskPercent, premium, premSL, lotSize, sizeMult = 1.0 }) {
    const effectiveRisk = riskPercent * sizeMult;
    const maxRisk = accountSize * (effectiveRisk / 100);
    const riskPerLot = Math.max(1, (premium - premSL) * lotSize);
    const lots = Math.max(1, Math.floor(maxRisk / riskPerLot));
    const capital = lots * lotSize * premium;
    const maxLoss = lots * lotSize * (premium - premSL);
    return {
        lots,
        quantity: lots * lotSize,
        capitalRequired: Math.round(capital),
        maxLoss: Math.round(maxLoss),
        effectiveRiskPercent: parseFloat(effectiveRisk.toFixed(2))
    };
}

// Time-stop = 15:15 IST same day
function todayTimeStop() {
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 15, 0);
    return t.getTime();
}

// ============================================================
//  Main: enrich an orchestrator verdict
// ============================================================
export function buildActionableSignal({ verdict, candles, chain, symbol, accountSize, riskPercent, sizeMult = 1.0 }) {
    if (!verdict || verdict.side === 'NO_TRADE') return null;
    const last = candles[candles.length - 1];
    const atrSer = atr(candles, 14);
    const atrV = atrSer.length ? atrSer[atrSer.length - 1] : (last.high - last.low);
    const meta = SYMBOL_META[symbol] || { lot_size: 25, strike_gap: 50 };

    const strike = selectStrike({
        side: verdict.side, spot: last.close, chain,
        tier: verdict.tier || 'B', symbol
    });
    const levels = computeLevels({
        side: verdict.side, spot: last.close,
        atrV, delta: strike.delta, premium: strike.premium
    });
    const sizing = computeSizing({
        accountSize: accountSize || 500000,
        riskPercent: riskPercent || 2,
        premium: strike.premium,
        premSL: levels.premium.stopLoss,
        lotSize: meta.lot_size,
        sizeMult
    });

    const firingStrategies = (verdict.votes || [])
        .filter(v => v.fired)
        .map(v => ({ id: v.id, name: v.name, weight: v.weight, side: v.side, reason: v.reason }));

    return {
        id: 'sig_' + Date.now().toString(36),
        time: Date.now(),
        symbol,
        side: verdict.side,
        tier: verdict.tier,
        confluenceScore: verdict.confluenceScore,
        regime: verdict.regime?.regime,

        // EXECUTION DETAIL — the user's hard requirements
        option: {
            strike: strike.strike,
            right: strike.right,
            offset: strike.offset,
            offsetLabel: strike.offset === 0 ? 'ATM' : strike.offset < 0 ? `ITM-${Math.abs(strike.offset)}` : `OTM+${strike.offset}`,
            premium: strike.premium,
            premiumSL: levels.premium.stopLoss,
            premiumT1: levels.premium.target1,
            premiumT2: levels.premium.target2,
            delta: strike.delta,
            iv: strike.iv,
            oi: strike.oi,
            lotSize: meta.lot_size,
            chainSource: strike.source
        },
        spot: levels.spot,
        riskReward: levels.riskReward,
        sizing,
        timeStop: todayTimeStop(),

        // CONTEXT
        firingStrategies,
        strategyCount: firingStrategies.length,
        warnings: verdict.warnings || [],
        eventGate: verdict.eventGate,

        // Concise human-readable summary
        summary: `BUY ${strike.strike} ${strike.right} @ ₹${strike.premium.toFixed(2)} · SL ₹${levels.premium.stopLoss.toFixed(2)} · T1 ₹${levels.premium.target1.toFixed(2)} · ${sizing.lots} lots · Max Loss ${'₹' + sizing.maxLoss.toLocaleString('en-IN')}`
    };
}
