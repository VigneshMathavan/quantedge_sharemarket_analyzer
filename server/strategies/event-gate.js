// strategies/event-gate.js — Macro event blackout calendar.
//
// During major scheduled events (RBI MPC, FOMC, Indian Budget, CPI/IIP releases),
// directional intraday signals statistically underperform — gap moves and IV
// crush dominate. This module blocks fresh entries:
//
//   • 2 hours BEFORE the event start (premium gets bid up, fills slip)
//   • 1 hour AFTER (the post-event volatility expansion / IV crush makes
//     directional bets unreliable)
//
// To update: edit EVENTS_2026 below or, when we wire it up to ForexFactory /
// TradingEconomics free API, fetch dynamically.

// Hardcoded high-impact event calendar for 2026 (IST times)
// Format: [ISO datetime in IST, severity, label]
const EVENTS_2026 = [
    // RBI MPC meetings (6 per year, every ~2 months, 10:00 IST policy announcement)
    ['2026-02-06T10:00', 'HIGH', 'RBI MPC Policy'],
    ['2026-04-09T10:00', 'HIGH', 'RBI MPC Policy'],
    ['2026-06-04T10:00', 'HIGH', 'RBI MPC Policy'],
    ['2026-08-06T10:00', 'HIGH', 'RBI MPC Policy'],
    ['2026-10-08T10:00', 'HIGH', 'RBI MPC Policy'],
    ['2026-12-03T10:00', 'HIGH', 'RBI MPC Policy'],

    // FOMC (8 per year, 23:30-00:00 IST)
    ['2026-01-30T00:30', 'HIGH', 'FOMC Decision'],
    ['2026-03-20T23:30', 'HIGH', 'FOMC Decision'],
    ['2026-05-02T00:30', 'HIGH', 'FOMC Decision'],
    ['2026-06-19T23:30', 'HIGH', 'FOMC Decision'],
    ['2026-07-31T00:30', 'HIGH', 'FOMC Decision'],
    ['2026-09-18T23:30', 'HIGH', 'FOMC Decision'],
    ['2026-11-07T00:30', 'HIGH', 'FOMC Decision'],
    ['2026-12-19T00:30', 'HIGH', 'FOMC Decision'],

    // India Budget (typically Feb 1)
    ['2026-02-01T11:00', 'EXTREME', 'Union Budget'],

    // India CPI inflation releases (mid-month)
    ['2026-01-12T17:30', 'MEDIUM', 'India CPI'],
    ['2026-02-12T17:30', 'MEDIUM', 'India CPI'],
    ['2026-03-12T17:30', 'MEDIUM', 'India CPI'],
    ['2026-04-14T17:30', 'MEDIUM', 'India CPI'],
    ['2026-05-12T17:30', 'MEDIUM', 'India CPI'],
    ['2026-06-12T17:30', 'MEDIUM', 'India CPI'],

    // US Non-Farm Payrolls (first Friday of month, 18:00 IST)
    ['2026-01-09T18:00', 'HIGH', 'US Non-Farm Payrolls'],
    ['2026-02-06T18:00', 'HIGH', 'US Non-Farm Payrolls'],
    ['2026-03-06T18:00', 'HIGH', 'US Non-Farm Payrolls'],
    ['2026-04-03T18:00', 'HIGH', 'US Non-Farm Payrolls'],
    ['2026-05-01T18:00', 'HIGH', 'US Non-Farm Payrolls'],
    ['2026-06-05T18:00', 'HIGH', 'US Non-Farm Payrolls'],

    // US CPI (mid-month, 18:00 IST)
    ['2026-01-14T18:00', 'HIGH', 'US CPI'],
    ['2026-02-11T18:00', 'HIGH', 'US CPI'],
    ['2026-03-11T18:00', 'HIGH', 'US CPI'],
    ['2026-04-15T18:00', 'HIGH', 'US CPI'],
    ['2026-05-13T18:00', 'HIGH', 'US CPI'],
    ['2026-06-10T18:00', 'HIGH', 'US CPI'],
];

// Convert IST string to UTC unix ms (subtract 5:30)
function istToUnixMs(istStr) {
    const [datePart, timePart] = istStr.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [h, min] = timePart.split(':').map(Number);
    const utcMs = Date.UTC(y, m - 1, d, h, min, 0) - (5 * 3600 + 30 * 60) * 1000;
    return utcMs;
}

// Buffer windows by severity (in minutes)
const BUFFERS = {
    EXTREME: { before: 180, after: 120 },
    HIGH:    { before: 120, after: 60 },
    MEDIUM:  { before: 60,  after: 30 }
};

export function checkEventGate(now = Date.now()) {
    for (const [istTime, severity, label] of EVENTS_2026) {
        const eventMs = istToUnixMs(istTime);
        const buf = BUFFERS[severity] || BUFFERS.MEDIUM;
        const blockStart = eventMs - buf.before * 60 * 1000;
        const blockEnd   = eventMs + buf.after * 60 * 1000;
        if (now >= blockStart && now <= blockEnd) {
            const phase = now < eventMs ? 'pre' : 'post';
            const minsToEvent = Math.round((eventMs - now) / 60000);
            return {
                blocked: true,
                severity,
                label,
                phase,
                eventTime: eventMs,
                minsToEvent,
                reason: phase === 'pre'
                    ? `${label} in ${minsToEvent} min (${severity}) — fresh entries blocked`
                    : `${label} just occurred (${severity}) — wait ${Math.abs(minsToEvent) + (phase === 'post' ? buf.after : 0)} min for IV to settle`
            };
        }
    }
    return { blocked: false };
}

// For UI: get the next upcoming event
export function nextEvent(now = Date.now()) {
    let next = null;
    for (const [istTime, severity, label] of EVENTS_2026) {
        const eventMs = istToUnixMs(istTime);
        if (eventMs > now && (!next || eventMs < next.eventTime)) {
            next = { eventTime: eventMs, severity, label };
        }
    }
    if (!next) return null;
    next.minsAway = Math.round((next.eventTime - now) / 60000);
    next.hoursAway = (next.minsAway / 60).toFixed(1);
    return next;
}
