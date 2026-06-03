// server/risk-engine.js — LIVE RISK ENGINE
//
// Aggregates current market risk into a Low/Medium/High/Extreme level
// with the reasons that pushed it up.

export function computeLiveRisk({ params, ivForecast, eventGate, todayPnl, openPositions }) {
    const reasons = [];
    let score = 0;

    if (eventGate?.hasMajor) {
        score += 30;
        reasons.push('Major event today (RBI/CPI/Fed/GDP)');
    } else if (eventGate?.hasMinor) {
        score += 12;
        reasons.push('Minor event today');
    }
    if (eventGate?.nextEvent?.hoursUntil != null && eventGate.nextEvent.hoursUntil <= 24) {
        score += 10;
        reasons.push(`Event in ${Math.round(eventGate.nextEvent.hoursUntil)}h`);
    }

    if (ivForecast?.available) {
        if (ivForecast.atmIV >= 40) {
            score += 20;
            reasons.push(`High IV (ATM ${ivForecast.atmIV}%)`);
        }
        if (ivForecast.verdict === 'IV_COMPRESSION_LIKELY') {
            score += 15;
            reasons.push('IV crush risk');
        }
    }

    if (params?.volatility?.atrState === 'EXPANDING' && params.volatility.atrRatioVsPast >= 1.8) {
        score += 12;
        reasons.push(`Volatility surge (ATR ${params.volatility.atrRatioVsPast}× normal)`);
    }

    if (typeof todayPnl === 'number' && todayPnl < -5000) {
        const dd = Math.min(25, Math.floor(Math.abs(todayPnl) / 1000));
        score += dd;
        reasons.push(`Today drawdown ₹${todayPnl.toLocaleString()}`);
    }

    if (typeof openPositions === 'number' && openPositions >= 3) {
        score += 10;
        reasons.push(`${openPositions} positions open`);
    }

    if (params?.trend?.adx != null && params.trend.adx < 15) {
        score += 8;
        reasons.push(`Choppy (ADX ${params.trend.adx.toFixed(0)})`);
    }

    const istMs = Date.now() + (5*60+30) * 60000;
    const ist = new Date(istMs);
    const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (m >= 9*60+15 && m < 9*60+30) { score += 8; reasons.push('Opening 15 min'); }
    else if (m >= 15*60) { score += 12; reasons.push('Last 30 min — theta crush'); }

    score = Math.max(0, Math.min(100, score));
    const level = score >= 70 ? 'EXTREME' : score >= 45 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
    const recommendation = level === 'EXTREME' ? 'AVOID NEW POSITIONS'
        : level === 'HIGH' ? 'REDUCE SIZE 50% + tighten SL'
        : level === 'MEDIUM' ? 'Trade with discipline, normal size'
        : 'Favorable — full size';

    return { level, score, reasons: reasons.slice(0, 6), recommendation };
}
