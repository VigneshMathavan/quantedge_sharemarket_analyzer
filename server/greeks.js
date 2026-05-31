// server/greeks.js — Black-Scholes Greeks for Indian index options.
//
// Returns Δ (delta), Γ (gamma), Θ (theta — per day), V (vega — per 1% IV).
// Also returns IV-derived premium so you can validate against market premium.
//
// All formulae standard. Risk-free rate defaults to 7% (Indian 10Y G-Sec rough avg).

const SQRT_2PI = Math.sqrt(2 * Math.PI);

// Standard normal PDF & CDF
function pdf(x) { return Math.exp(-x * x / 2) / SQRT_2PI; }
function cdf(x) {
    // Abramowitz & Stegun 26.2.17 approximation
    const k = 1 / (1 + 0.2316419 * Math.abs(x));
    const a = (((1.330274429 * k - 1.821255978) * k + 1.781477937) * k - 0.356563782) * k + 0.319381530;
    const w = 1 - pdf(x) * a * k;
    return x >= 0 ? w : 1 - w;
}

// Time to expiry in years. expiryDate is JS Date or ms timestamp.
function tte(expiryMs, nowMs = Date.now()) {
    return Math.max(1 / 365 / 24, (expiryMs - nowMs) / (365 * 24 * 60 * 60 * 1000));
}

// Black-Scholes for European options on indices (no dividend).
// All inputs in absolute terms: S=spot, K=strike, T=years, r=annual rate (decimal), iv=annual vol (decimal).
export function blackScholes({ S, K, T, r = 0.07, iv, right = 'CE' }) {
    if (!S || !K || !iv || iv <= 0 || T <= 0) {
        return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, valid: false };
    }
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;
    const Nd1 = cdf(d1), Nd2 = cdf(d2);
    const pdfd1 = pdf(d1);

    let price, delta, theta;
    if (right === 'CE' || right === 'CALL') {
        price = S * Nd1 - K * Math.exp(-r * T) * Nd2;
        delta = Nd1;
        theta = -(S * pdfd1 * iv) / (2 * sqrtT) - r * K * Math.exp(-r * T) * Nd2;
    } else {  // PE
        price = K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
        delta = Nd1 - 1;
        theta = -(S * pdfd1 * iv) / (2 * sqrtT) + r * K * Math.exp(-r * T) * cdf(-d2);
    }
    const gamma = pdfd1 / (S * iv * sqrtT);
    const vega = S * pdfd1 * sqrtT;  // per 1.0 change in iv

    return {
        price: parseFloat(price.toFixed(2)),
        delta: parseFloat(delta.toFixed(4)),
        gamma: parseFloat(gamma.toFixed(6)),
        theta: parseFloat((theta / 365).toFixed(2)),    // per calendar day
        thetaPerHour: parseFloat((theta / 365 / 24).toFixed(3)),
        vega: parseFloat((vega / 100).toFixed(2)),       // per 1% iv (NOT 1.0)
        valid: true
    };
}

// Implied vol via Newton-Raphson — useful when market premium is known but IV isn't.
export function impliedVol({ S, K, T, r = 0.07, marketPrice, right = 'CE' }) {
    let iv = 0.20;  // starting guess
    for (let i = 0; i < 30; i++) {
        const { price, vega } = blackScholes({ S, K, T, r, iv, right });
        const diff = price - marketPrice;
        if (Math.abs(diff) < 0.05) return iv;
        if (!vega || vega < 0.001) break;
        iv -= diff / (vega * 100);  // vega scaled
        if (iv < 0.01) iv = 0.01;
        if (iv > 3) iv = 3;
    }
    return iv;
}

// Next weekly expiry for NIFTY (Thursday) / BANKNIFTY (Wednesday) / FINNIFTY (Tuesday).
// SENSEX expires Friday. Returns ms timestamp at 15:30 IST.
const EXPIRY_DOW = {
    NIFTY: 4,        // Thursday
    BANKNIFTY: 3,    // Wed (changed Sep 2024 — now monthly only; keeping weekly placeholder)
    FINNIFTY: 2,     // Tue
    SENSEX: 5        // Fri (BSE weekly)
};
export function nextExpiryMs(symbol = 'NIFTY', fromMs = Date.now()) {
    const targetDow = EXPIRY_DOW[symbol.toUpperCase()] || 4;
    const ist = new Date(fromMs + (5 * 60 + 30) * 60 * 1000);
    const dow = ist.getUTCDay();
    let daysAhead = (targetDow - dow + 7) % 7;
    // If today IS expiry but past 15:30 IST, roll to next week
    const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (daysAhead === 0 && istMin >= (15 * 60 + 30)) daysAhead = 7;
    const expIst = new Date(ist);
    expIst.setUTCDate(ist.getUTCDate() + daysAhead);
    expIst.setUTCHours(15, 30, 0, 0);  // 15:30 IST in IST-shifted UTC
    return expIst.getTime() - (5 * 60 + 30) * 60 * 1000;
}

// Days to expiry — useful for gamma blast detection and theta acceleration.
export function daysToExpiry(symbol, fromMs = Date.now()) {
    const expMs = nextExpiryMs(symbol, fromMs);
    return (expMs - fromMs) / (24 * 60 * 60 * 1000);
}
