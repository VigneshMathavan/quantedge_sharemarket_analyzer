// server/strategy/replay-day.js — Replay one trading day through Strategy v2.
//
// Loads NIFTY 5m data, filters to the requested date, walks each candle close
// through StrategyV2Engine, prints every signal that fired with full execution
// detail (strike, SL, T1, T2, reasoning), and simulates the outcome using the
// rest of the day's candles.
//
// Run:
//   node strategy/replay-day.js NIFTY 2026-05-27
//   node strategy/replay-day.js SENSEX 2026-05-27

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StrategyV2Engine } from './v2-overrides.js';
import { history } from '../history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const SYMBOL_META = {
    NIFTY:     { lot_size: 25, strike_gap: 50 },
    SENSEX:    { lot_size: 10, strike_gap: 100 }
};

// IST date helpers: input "2026-05-27" → UTC midnight bounds for that IST day
function istDayBounds(istDateStr) {
    // IST = UTC+5:30. IST midnight = UTC 18:30 of previous day.
    const [y, m, d] = istDateStr.split('-').map(Number);
    const istMidnightUtc = Date.UTC(y, m - 1, d) - (5 * 3600 + 30 * 60) * 1000;
    const istEndOfDayUtc = istMidnightUtc + 24 * 3600 * 1000;
    return [Math.floor(istMidnightUtc / 1000), Math.floor(istEndOfDayUtc / 1000)];
}

function istHMM(unixSec) {
    const d = new Date(unixSec * 1000);
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
    const h = ist.getUTCHours().toString().padStart(2, '0');
    const m = ist.getUTCMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
}

function fmtINR(v) { return '₹' + Math.round(v).toLocaleString('en-IN'); }

function syntheticChain(spot, symbol, vix = 14) {
    const meta = SYMBOL_META[symbol];
    const gap = meta.strike_gap;
    const atm = Math.round(spot / gap) * gap;
    const out = [];
    for (let i = -8; i <= 8; i++) {
        const strike = atm + i * gap;
        const dist = Math.abs(i);
        const intrinsicCE = Math.max(0, spot - strike);
        const intrinsicPE = Math.max(0, strike - spot);
        const timeValue = Math.max(5, (spot * 0.005) / (1 + dist * 0.35));
        const oi = Math.floor((900000 + Math.random() * 1500000) / (1 + dist * 0.25));
        const iv = vix * 0.9 + dist * 0.4;
        out.push({ strike, type: 'CE', ltp: parseFloat((intrinsicCE + timeValue).toFixed(2)), oi, iv: parseFloat(iv.toFixed(2)), oiChange: 0 });
        out.push({ strike, type: 'PE', ltp: parseFloat((intrinsicPE + timeValue).toFixed(2)), oi, iv: parseFloat(iv.toFixed(2)), oiChange: 0 });
    }
    return out;
}

// Time-stop = 15:15 IST same day. Compute as unix sec.
function dayTimeStop(signalTimeSec) {
    const d = new Date(signalTimeSec * 1000);
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
    ist.setUTCHours(9, 45, 0, 0);  // 09:45 UTC = 15:15 IST
    return Math.floor((ist.getTime() - (5 * 60 + 30) * 60 * 1000) / 1000);
}

function simulateExit(signal, futureCandles) {
    const lotSize = signal.option.lotSize;
    const isCall = signal.side === 'BUY_CALL';
    const delta = signal.option.delta;
    const entry = signal.option.premium;
    const sl = signal.option.premiumSL;
    const t1 = signal.option.premiumT1;
    const signalSec = signal.time / 1000;
    const hardStop = dayTimeStop(signalSec);

    let exitPrem = entry, exitTime = signalSec, exitReason = 'TIME_STOP';
    let exitIdx = -1;

    for (let idx = 0; idx < futureCandles.length; idx++) {
        const c = futureCandles[idx];
        // HARD time stop: no holding past 15:15 IST
        if (c.time > hardStop) {
            const lastSpot = futureCandles[idx - 1]?.close ?? signal.spot.entry;
            const spotMove = lastSpot - signal.spot.entry;
            const directionalPnL = (isCall ? spotMove : -spotMove) * delta;
            const minutes = (c.time - signalSec) / 60;
            exitPrem = Math.max(0.5, entry + directionalPnL - entry * 0.0008 * minutes);
            exitTime = hardStop;
            exitReason = 'TIME_STOP';
            exitIdx = idx;
            break;
        }
        const spotMove = c.close - signal.spot.entry;
        const directionalPnL = (isCall ? spotMove : -spotMove) * delta;
        const minutesElapsed = (c.time - signalSec) / 60;
        const thetaBleed = entry * 0.0008 * Math.max(0, minutesElapsed);
        const cur = Math.max(0.5, entry + directionalPnL - thetaBleed);
        exitPrem = cur;
        if (cur <= sl) { exitPrem = sl; exitTime = c.time; exitReason = 'SL_HIT'; exitIdx = idx; break; }
        if (cur >= t1) { exitPrem = t1; exitTime = c.time; exitReason = 'TARGET_HIT'; exitIdx = idx; break; }
    }
    const lots = signal.sizing.lots;
    const grossPnL = (exitPrem - entry) * lots * lotSize;
    const costs = (entry + exitPrem) * 0.01 * lots * lotSize + 80 + exitPrem * 0.0005 * lots * lotSize;
    const netPnL = grossPnL - costs;
    return { exitPrem, exitTime, exitReason, netPnL, costs, exitIdx };
}

async function main() {
    const symbol = process.argv[2] || 'NIFTY';
    const dateStr = process.argv[3] || '2026-05-27';

    const filePath = path.join(DATA_DIR, `${symbol}_5minute.json`);
    if (!fs.existsSync(filePath)) { console.error(`No data: ${filePath}`); process.exit(1); }
    const allCandles = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // VIX for date
    let vixHint = 14;
    const vixPath = path.join(DATA_DIR, 'INDIA_VIX_1day.json');
    if (fs.existsSync(vixPath)) {
        const vix = JSON.parse(fs.readFileSync(vixPath, 'utf-8'));
        const [dayStart] = istDayBounds(dateStr);
        const v = vix.find(x => Math.abs(x.time - dayStart) < 86400 * 2);
        if (v) vixHint = v.close;
    }

    const [from, to] = istDayBounds(dateStr);
    const dayCandles = allCandles.filter(c => c.time >= from && c.time < to);

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`  ${symbol} session replay — ${dateStr} IST (Strategy v2)`);
    console.log(`${'═'.repeat(78)}`);
    if (dayCandles.length === 0) {
        console.log(`  No candles for ${dateStr}. Available range:`);
        console.log(`    ${new Date(allCandles[0].time * 1000).toISOString().slice(0,10)} → ${new Date(allCandles[allCandles.length-1].time * 1000).toISOString().slice(0,10)}`);
        process.exit(0);
    }
    console.log(`  Candles today: ${dayCandles.length} (${istHMM(dayCandles[0].time)} → ${istHMM(dayCandles[dayCandles.length-1].time)} IST)`);
    console.log(`  Open: ${dayCandles[0].open.toFixed(2)}  High: ${Math.max(...dayCandles.map(c=>c.high)).toFixed(2)}  Low: ${Math.min(...dayCandles.map(c=>c.low)).toFixed(2)}  Close: ${dayCandles[dayCandles.length-1].close.toFixed(2)}`);
    console.log(`  Day range: ${((Math.max(...dayCandles.map(c=>c.high)) - Math.min(...dayCandles.map(c=>c.low))) / dayCandles[0].open * 100).toFixed(2)}%`);
    console.log(`  India VIX:  ${vixHint.toFixed(2)}`);

    // Build engine — opportunistic mode (fires on any valid setup)
    const engine = new StrategyV2Engine({
        cooldownSec: 0,
        confLower: 35,              // floor only — no upper cap
        innerThreshold: 30,         // inner engine fires on lower base
        ivHistory: { [symbol]: [] }
    });

    // Pre-seed IV history with recent days
    const seedHistory = allCandles.slice(0, allCandles.indexOf(dayCandles[0]));
    let lastSeedDay = -1;
    for (const c of seedHistory.slice(-300)) {
        engine.engine.opts.ivHistory[symbol].push(vixHint * 0.9 + Math.random() * 2);
        if (engine.engine.opts.ivHistory[symbol].length > 60) engine.engine.opts.ivHistory[symbol].shift();
    }

    const signals = [];
    const startIdx = allCandles.indexOf(dayCandles[0]);

    console.log(`\n  Walking ${dayCandles.length} candles through Strategy v2...\n`);

    let candidatesSeen = 0, candidatesBlocked = 0;
    let cumPnLLive = 0;
    const dailyLossLimit = 500000 * 0.03;  // 3% daily DD halt

    let i = 0;
    while (i < dayCandles.length) {
        const globalIdx = startIdx + i;
        const slice = allCandles.slice(Math.max(0, globalIdx - 200), globalIdx + 1);
        const last = slice[slice.length - 1];
        const chain = syntheticChain(last.close, symbol, vixHint);

        const atmRows = chain.filter(o => o.type === 'CE' && Math.abs(o.strike - last.close) < SYMBOL_META[symbol].strike_gap * 2);
        if (atmRows.length) {
            const atmIV = atmRows.reduce((a, b) => a + b.iv, 0) / atmRows.length;
            engine.engine.opts.ivHistory[symbol].push(atmIV);
            if (engine.engine.opts.ivHistory[symbol].length > 60) engine.engine.opts.ivHistory[symbol].shift();
        }

        // Daily loss circuit-breaker
        if (cumPnLLive < -dailyLossLimit) {
            // Stop trading for the day
            break;
        }

        const sig = await engine.evaluate({
            symbol, candles: slice, currentPrice: last.close, chain,
            accountSize: 500000, riskPercent: 1.5,
            ivHistory: engine.engine.opts.ivHistory
        });

        if (sig.side === 'NO_TRADE') {
            if (sig.blockedReasons) candidatesBlocked++;
            if (sig.confidence >= 40) candidatesSeen++;
            i++;
            continue;
        }

        candidatesSeen++;
        // Fire signal; advance i past the exit so no overlapping trade
        engine.engine.lastSignalAt[symbol] = 0;
        sig.time = last.time * 1000;
        const future = allCandles.slice(globalIdx + 1, globalIdx + 80);
        const outcome = simulateExit(sig, future);
        cumPnLLive += outcome.netPnL;
        signals.push({ candle: last, signal: sig, outcome });

        // Persist to weekly history store
        if (process.env.QE_SAVE_HISTORY !== '0') {
            history.addTrade({
                time: last.time * 1000,
                exitTime: (outcome.exitTime || last.time) * 1000,
                symbol,
                side: sig.side,
                strike: sig.option.strike,
                right: sig.option.right,
                confidence: sig.confidence,
                tier: sig.tier,
                regime: sig.regime?.regime,
                entry: sig.option.premium,
                exit: parseFloat(outcome.exitPrem.toFixed(2)),
                stopLoss: sig.option.premiumSL,
                target1: sig.option.premiumT1,
                target2: sig.option.premiumT2,
                lots: sig.sizing.lots,
                quantity: sig.sizing.quantity,
                pnl: parseFloat(outcome.netPnL.toFixed(2)),
                costs: parseFloat(outcome.costs.toFixed(2)),
                result: outcome.netPnL > 0 ? 'WIN' : 'LOSS',
                exitReason: outcome.exitReason,
                spotEntry: sig.spot.entry,
                spotExit: future?.[outcome.exitIdx]?.close,
                source: 'replay'
            });
        }

        // Jump i to after exit (1 candle past) — emulate "can't enter new trade
        // while in position", which is how a real trader operates.
        const advance = outcome.exitIdx >= 0 ? outcome.exitIdx + 2 : 3;
        i += advance;
    }

    console.log(`  ─ Engine touched ${candidatesSeen} setups, blocked ${candidatesBlocked} via v2 rules, fired ${signals.length} live signals.\n`);

    if (signals.length === 0) {
        console.log(`  📭 No signals fired for ${symbol} on ${dateStr}.`);
        console.log(`     The engine's filters all kicked in (good behavior — most days SHOULD be no-trade).\n`);
        process.exit(0);
    }

    // Print each signal
    let cumPnL = 0;
    signals.forEach((s, idx) => {
        const sig = s.signal;
        const o = s.outcome;
        cumPnL += o.netPnL;
        const headChar = sig.side === 'BUY_CALL' ? '🟢' : '🔴';
        const outcomeChar = o.netPnL > 0 ? '✓ WIN ' : '✗ LOSS';
        console.log(`${'─'.repeat(78)}`);
        console.log(`  SIGNAL ${idx + 1} · ${istHMM(s.candle.time)} IST · ${headChar} ${sig.side.replace('_', ' ')} · ${outcomeChar}`);
        console.log(`${'─'.repeat(78)}`);
        console.log(`  Confidence: ${sig.confidence}% (${sig.tier})   Regime: ${sig.regime?.regime || 'unknown'}`);
        console.log(`  ── EXECUTION ──`);
        console.log(`  Strike:     ${sig.option.strike} ${sig.option.right}`);
        console.log(`  Entry:      ₹${sig.option.premium}  (spot ${sig.spot.entry.toFixed(2)})`);
        console.log(`  Stop Loss:  ₹${sig.option.premiumSL.toFixed(2)}   (spot ${sig.spot.stopLoss.toFixed(2)})`);
        console.log(`  Target 1:   ₹${sig.option.premiumT1.toFixed(2)}   (spot ${sig.spot.target1.toFixed(2)})`);
        console.log(`  Target 2:   ₹${sig.option.premiumT2.toFixed(2)}   (spot ${sig.spot.target2.toFixed(2)})`);
        console.log(`  Lots:       ${sig.sizing.lots}  (${sig.sizing.quantity} qty)`);
        console.log(`  Capital:    ${fmtINR(sig.sizing.capitalRequired)}   Max Loss: ${fmtINR(sig.sizing.maxLoss)}`);
        console.log(`  ── REASONING ──`);
        sig.reasoning.forEach(r => console.log(`    ${r}`));
        console.log(`  ── OUTCOME ──`);
        console.log(`  Exit:       ${o.exitReason} at ₹${o.exitPrem.toFixed(2)} (${istHMM(o.exitTime)} IST)`);
        const pnlSign = o.netPnL >= 0 ? '+' : '';
        console.log(`  Net P&L:    ${pnlSign}${fmtINR(o.netPnL)}   (gross ${fmtINR(o.netPnL + o.costs)} - costs ${fmtINR(o.costs)})`);
        console.log(`  Running:    ${cumPnL >= 0 ? '+' : ''}${fmtINR(cumPnL)}`);
        console.log('');
    });

    console.log(`${'═'.repeat(78)}`);
    const wins = signals.filter(s => s.outcome.netPnL > 0).length;
    console.log(`  SESSION SUMMARY — ${dateStr} ${symbol}`);
    console.log(`${'═'.repeat(78)}`);
    console.log(`  Total Signals:  ${signals.length}`);
    console.log(`  Wins / Losses:  ${wins} / ${signals.length - wins}`);
    console.log(`  Win Rate:       ${(wins / signals.length * 100).toFixed(1)}%`);
    console.log(`  Net P&L:        ${cumPnL >= 0 ? '+' : ''}${fmtINR(cumPnL)}`);
    console.log(`  As % of ₹5L:    ${(cumPnL / 500000 * 100).toFixed(2)}%`);
    console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
