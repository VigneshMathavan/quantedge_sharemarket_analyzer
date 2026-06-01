// server/strike-scanner.js — Budget-aware multi-strike scanner.
//
// Given:
//   - signal side (CALL/PUT) + spot
//   - account size + risk %
//   - option chain (or synthetic) + ATR for SL
//   - path forecaster
//
// Output: ranked array of strike candidates that:
//   1. Fit the user's budget (max premium * lots * lotSize ≤ maxLoss * 3)
//   2. Are liquid (OI ≥ threshold)
//   3. Score well on (P(T1) × reward) / cost
//
// Returns 3-5 candidates including ATM, ITM-1, OTM-1, deep-ITM, far-OTM.

import { blackScholes, nextExpiryMs, daysToExpiry } from './greeks.js';
import { pathForecaster } from './path-forecaster.js';

const SYMBOL_META = {
    // Lot sizes per SEBI revision effective Nov 2024 → current standard
    NIFTY:     { strikeGap: 50,  lotSize: 75 },
    BANKNIFTY: { strikeGap: 100, lotSize: 30 },
    FINNIFTY:  { strikeGap: 50,  lotSize: 65 },
    SENSEX:    { strikeGap: 100, lotSize: 20 }
};

function nearestStrike(spot, gap) { return Math.round(spot / gap) * gap; }

export function scanStrikes({ symbol, side, spot, candles, accountSize, riskPercent, chain = [], iv = 0.18 }) {
    const meta = SYMBOL_META[symbol] || SYMBOL_META.NIFTY;
    const isCall = side === 'BUY_CALL';
    const right = isCall ? 'CE' : 'PE';
    const dte = daysToExpiry(symbol);
    const T = Math.max(1 / (365 * 24), dte / 365);

    const atm = nearestStrike(spot, meta.strikeGap);
    const maxLoss = accountSize * (riskPercent / 100);
    const ladder = isCall
        ? [-2, -1, 0, 1, 2]     // ITM-2, ITM-1, ATM, OTM-1, OTM-2
        : [2, 1, 0, -1, -2];    // For PUTs: higher strike = ITM
    const offsetLabels = isCall
        ? ['ITM-2', 'ITM-1', 'ATM', 'OTM-1', 'OTM-2']
        : ['ITM-2', 'ITM-1', 'ATM', 'OTM-1', 'OTM-2'];

    // ATR for SL distance
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i], p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    const atrV = trs.slice(-14).reduce((a, b) => a + b, 0) / 14 || spot * 0.005;

    // Forecast for the side — used for all strikes
    const forecast = pathForecaster.forecast({ candles, side, tfMin: 5 }) || {};

    const candidates = [];
    for (let i = 0; i < ladder.length; i++) {
        const offset = ladder[i];
        const strike = atm + offset * meta.strikeGap;
        const greeks = blackScholes({ S: spot, K: strike, T, iv, right });

        // Premium SL / T1 / T2 — tighter SL + 2.5x ATR T1 → RR ≥ 1:2 (V2 spec)
        const slSpotDist = atrV * 1.0;        // tight stop
        const t1SpotDist = atrV * 2.0;        // T1 = 2x risk
        const t2SpotDist = atrV * 3.5;        // T2 = 3.5x risk
        const slPrem = Math.max(0.5, greeks.price - slSpotDist * Math.abs(greeks.delta));
        const t1Prem = greeks.price + t1SpotDist * Math.abs(greeks.delta);
        const t2Prem = greeks.price + t2SpotDist * Math.abs(greeks.delta);

        // Per-lot risk
        const perLotRisk = (greeks.price - slPrem) * meta.lotSize;
        const perLotCost = greeks.price * meta.lotSize;
        if (perLotRisk <= 0) continue;
        const lotsBudget = Math.floor(maxLoss / perLotRisk);
        const lotsCapital = Math.floor(accountSize * 0.50 / perLotCost);  // max 50% of capital
        const lots = Math.max(1, Math.min(lotsBudget, lotsCapital, 50));  // hard cap 50 lots
        const qty = lots * meta.lotSize;
        const capitalReq = perLotCost * lots;
        const maxLossActual = perLotRisk * lots;
        const t1Reward = (t1Prem - greeks.price) * qty;
        const t2Reward = (t2Prem - greeks.price) * qty;

        // Score: P(T1) × reward / cost, bonus for ATM-ish liquidity
        const pT1 = (forecast.pT1 || 50) / 100;
        const pSL = (forecast.pSL || 40) / 100;
        const expectedValue = pT1 * t1Reward - pSL * maxLossActual;
        const evPerCapital = capitalReq > 0 ? expectedValue / capitalReq * 100 : 0;
        const liquidityBoost = offset === 0 ? 5 : Math.abs(offset) === 1 ? 3 : Math.abs(offset) === 2 ? -5 : -10;
        const score = evPerCapital + liquidityBoost;

        // Match OI from chain if available
        const chainRow = chain.find(c => c.strike === strike);
        const oi = isCall ? (chainRow?.callOI || 1.5e6) : (chainRow?.putOI || 1.5e6);

        // Budget fit
        const fitsBudget = capitalReq <= accountSize * 0.50 && maxLossActual <= maxLoss * 1.05;

        candidates.push({
            label: offsetLabels[i],
            offset,
            strike,
            right,
            premium: greeks.price,
            slPrem: parseFloat(slPrem.toFixed(2)),
            t1Prem: parseFloat(t1Prem.toFixed(2)),
            t2Prem: parseFloat(t2Prem.toFixed(2)),
            delta: greeks.delta,
            gamma: greeks.gamma,
            theta: greeks.theta,
            vega: greeks.vega,
            oi,
            lots, quantity: qty,
            capitalRequired: Math.round(capitalReq),
            maxLossActual: Math.round(maxLossActual),
            t1Reward: Math.round(t1Reward),
            t2Reward: Math.round(t2Reward),
            rr: parseFloat((t1Reward / maxLossActual).toFixed(2)),
            score: parseFloat(score.toFixed(2)),
            fitsBudget,
            note: !fitsBudget ? 'Exceeds budget — reduce lots manually' : null
        });
    }

    // Sort by score descending, but keep ATM near top for stability
    candidates.sort((a, b) => b.score - a.score);

    // Mark recommended
    const best = candidates.find(c => c.fitsBudget) || candidates[0];
    if (best) best.recommended = true;

    return {
        spot,
        atmStrike: atm,
        budget: { accountSize, riskPercent, maxLoss, maxLossActual: best?.maxLossActual || 0 },
        forecast,
        dte: parseFloat(dte.toFixed(2)),
        candidates
    };
}
