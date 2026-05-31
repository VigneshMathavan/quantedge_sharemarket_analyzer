// server/gamma-blast.js — Detects "gamma blast" conditions for live trades.
//
// What is a gamma blast?
//   When DTE → 0 and spot is near strike (ATM), gamma spikes hard. A tiny
//   spot move can multiply the premium 2-5x in minutes. Used by pros on
//   expiry day to ride the kink near strike.
//
// Detection logic:
//   1. DTE < 2 days
//   2. |spot - strike| / strike < 0.3%
//   3. Gamma > 0.005
//   4. Recent spot acceleration (last 3 candles momentum) in trade direction
//
// Severity score 0-100. Above 70 = "BLAST IMMINENT — hold or scale-in".

import { blackScholes, daysToExpiry, nextExpiryMs } from './greeks.js';

export function detectGammaBlast({ candles, symbol, strike, right, iv = 0.18, spotNow, side }) {
    if (!candles || candles.length < 4 || !strike) return null;
    const dte = daysToExpiry(symbol);
    if (dte > 3) return { severity: 0, active: false, reason: 'DTE>3, gamma still flat', dte };

    const spot = spotNow || candles[candles.length - 1].close;
    const T = Math.max(1 / (365 * 24), dte / 365);
    const g = blackScholes({ S: spot, K: strike, T, iv, right: right || 'CE' });
    const moneyness = (spot - strike) / strike;
    const atmness = 1 - Math.min(1, Math.abs(moneyness) / 0.003);  // 1.0 if exactly ATM, drops to 0 at 0.3% away

    // Spot acceleration — last 3 vs prior 3 ranges
    const last3 = candles.slice(-3);
    const prior3 = candles.slice(-6, -3);
    const last3Move = last3[2].close - prior3[0].close;
    const last3Range = Math.max(...last3.map(c => c.high)) - Math.min(...last3.map(c => c.low));
    const prior3Range = Math.max(...prior3.map(c => c.high)) - Math.min(...prior3.map(c => c.low));
    const accel = prior3Range > 0 ? last3Range / prior3Range : 1;

    // Direction match: if going long CE, we want spot moving UP; if PE, DOWN
    const dirMatch = (right === 'CE' && last3Move > 0) || (right === 'PE' && last3Move < 0);

    // Severity components
    const sDte = dte < 0.5 ? 100 : dte < 1 ? 85 : dte < 2 ? 60 : 30;
    const sAtmness = atmness * 100;
    const sGamma = Math.min(100, g.gamma * 1500);  // gamma 0.066 → 100
    const sAccel = Math.min(100, accel * 50);
    const sDirMatch = dirMatch ? 100 : 0;

    const severity = Math.round(
        sDte * 0.30 + sAtmness * 0.30 + sGamma * 0.20 + sAccel * 0.15 + sDirMatch * 0.05
    );

    // Estimated 1% spot move → premium % change (gamma-blast magnification)
    const oneMovePts = spot * 0.001;  // 0.1% spot move
    const expectedPremMove = oneMovePts * g.delta + 0.5 * g.gamma * oneMovePts * oneMovePts;
    const premPctMove = (g.price > 0) ? (expectedPremMove / g.price * 100) : 0;

    let label = 'inactive';
    let action = null;
    if (severity >= 75) { label = '🚀 BLAST IMMINENT'; action = 'Hold tight — gamma is loaded; small spot move = explosive premium'; }
    else if (severity >= 55) { label = '🔥 GAMMA HOT'; action = 'High Γ — book partial at +30%, ride rest'; }
    else if (severity >= 35) { label = '⚠ ELEVATED Γ'; action = 'Watch spot — gamma rising as expiry approaches'; }
    else { label = '· Normal'; action = 'No gamma blast risk'; }

    return {
        active: severity >= 35,
        severity,
        label,
        action,
        dte: parseFloat(dte.toFixed(2)),
        moneyness: parseFloat((moneyness * 100).toFixed(3)),
        atmness: parseFloat(atmness.toFixed(2)),
        gamma: g.gamma,
        delta: g.delta,
        theta: g.theta,
        vega: g.vega,
        bsPrice: g.price,
        accel: parseFloat(accel.toFixed(2)),
        dirMatch,
        expectedMoveFor0p1Pct: parseFloat(premPctMove.toFixed(1))  // % premium change per 0.1% spot move
    };
}
