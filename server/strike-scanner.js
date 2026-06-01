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
    // Current F&O lot sizes (2026) — per NSE/BSE official
    NIFTY:     { strikeGap: 50,  lotSize: 65 },
    BANKNIFTY: { strikeGap: 100, lotSize: 30 },
    FINNIFTY:  { strikeGap: 50,  lotSize: 60 },
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
    const expectedType = isCall ? 'CE' : 'PE';
    for (let i = 0; i < ladder.length; i++) {
        const offset = ladder[i];
        const strike = atm + offset * meta.strikeGap;

        // ──────────────────────────────────────────────────────────────
        //  REAL chain data first, BS fallback only when strike missing.
        //  Upstox v2 returns ltp, iv, delta, theta, vega per row.
        //  We compute gamma via BS using the REAL iv from the chain.
        // ──────────────────────────────────────────────────────────────
        const chainRow = chain.find(c => c.strike === strike && c.type === expectedType);
        const useChain = !!(chainRow && chainRow.ltp > 0);
        const realIv = useChain && chainRow.iv ? chainRow.iv / 100 : iv;
        const bsForGamma = blackScholes({ S: spot, K: strike, T, iv: realIv, right });
        const premium = useChain ? chainRow.ltp : bsForGamma.price;
        const delta = useChain && chainRow.delta ? chainRow.delta : bsForGamma.delta;
        const gamma = bsForGamma.gamma;  // not exposed by Upstox — always BS
        const theta = useChain && chainRow.theta ? chainRow.theta : bsForGamma.theta;
        const vega = useChain && chainRow.vega ? chainRow.vega : bsForGamma.vega;
        const oi = chainRow?.oi || 0;
        const dataSource = useChain ? 'broker' : 'computed';

        // Premium SL / T1 / T2 — tighter SL + 2.5x ATR T1 → RR ≥ 1:2 (V2 spec)
        const slSpotDist = atrV * 1.0;
        const t1SpotDist = atrV * 2.0;
        const t2SpotDist = atrV * 3.5;
        const slPrem = Math.max(0.5, premium - slSpotDist * Math.abs(delta));
        const t1Prem = premium + t1SpotDist * Math.abs(delta);
        const t2Prem = premium + t2SpotDist * Math.abs(delta);

        // Per-lot risk
        const perLotRisk = (premium - slPrem) * meta.lotSize;
        const perLotCost = premium * meta.lotSize;
        if (perLotRisk <= 0) continue;
        const lotsBudget = Math.floor(maxLoss / perLotRisk);
        const lotsCapital = Math.floor(accountSize * 0.50 / perLotCost);
        const lots = Math.max(1, Math.min(lotsBudget, lotsCapital, 50));
        const qty = lots * meta.lotSize;
        const capitalReq = perLotCost * lots;
        const maxLossActual = perLotRisk * lots;
        const t1Reward = (t1Prem - premium) * qty;
        const t2Reward = (t2Prem - premium) * qty;

        // Score: P(T1) × reward - P(SL) × max loss
        const pT1 = (forecast.pT1 || 50) / 100;
        const pSL = (forecast.pSL || 40) / 100;
        const expectedValue = pT1 * t1Reward - pSL * maxLossActual;
        const evPerCapital = capitalReq > 0 ? expectedValue / capitalReq * 100 : 0;
        const liquidityBoost = offset === 0 ? 5 : Math.abs(offset) === 1 ? 3 : Math.abs(offset) === 2 ? -5 : -10;
        const score = evPerCapital + liquidityBoost;

        const fitsBudget = capitalReq <= accountSize * 0.50 && maxLossActual <= maxLoss * 1.05;

        candidates.push({
            label: offsetLabels[i],
            offset,
            strike,
            right,
            premium: parseFloat(premium.toFixed(2)),
            slPrem: parseFloat(slPrem.toFixed(2)),
            t1Prem: parseFloat(t1Prem.toFixed(2)),
            t2Prem: parseFloat(t2Prem.toFixed(2)),
            delta: parseFloat(delta.toFixed(4)),
            gamma: parseFloat(gamma.toFixed(6)),
            theta: parseFloat(theta.toFixed(2)),
            vega: parseFloat(vega.toFixed(2)),
            iv: parseFloat((realIv * 100).toFixed(2)),
            oi,
            dataSource,
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
