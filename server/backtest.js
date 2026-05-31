// server/backtest.js — Walk-forward backtester
//
// Pulls historical candles via the provider, walks them candle-by-candle
// with SignalEngineV2, simulates fills + SL/T1 hits in option premium space,
// records every trade outcome (with featureVector) so we can:
//   1. Compute equity curve + win rate + Sharpe + max DD
//   2. Export trades as training data for ML retraining
//
// Run modes:
//   • Live broker-fed historical (when creds present)
//   • Mock provider (works offline; useful to validate engine logic)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SignalEngineV2, classifyRegime, sessionPhase } from './signal2.js';
import { SYMBOL_MAP } from './breeze.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
//  Mock option chain generator
// ============================================================
// We don't have historical option chain snapshots from most brokers.
// We synthesize a plausible chain from spot price + assumed IV.
// This is good enough for backtesting because the strike-selection logic
// only needs spot+chain to pick an ATM/ITM/OTM strike with reasonable premium.
function syntheticChain(spot, symbol) {
    const gap = SYMBOL_MAP[symbol]?.strike_gap || 50;
    const atm = Math.round(spot / gap) * gap;
    const ivBase = 14 + Math.random() * 6;
    const out = [];
    for (let i = -8; i <= 8; i++) {
        const strike = atm + i * gap;
        const dist = Math.abs(i);
        const intrinsicCall = Math.max(0, spot - strike);
        const intrinsicPut = Math.max(0, strike - spot);
        const timeValue = Math.max(8, 70 / (1 + dist * 0.35));
        const oi = Math.floor((900000 + Math.random() * 1500000) / (1 + dist * 0.25));
        const iv = ivBase + dist * 0.4 + (Math.random() - 0.5) * 2;
        out.push({
            strike, type: 'CE',
            ltp: parseFloat((intrinsicCall + timeValue).toFixed(2)),
            oi, oiChange: Math.floor((Math.random() - 0.5) * 200000),
            iv: parseFloat(iv.toFixed(2))
        });
        out.push({
            strike, type: 'PE',
            ltp: parseFloat((intrinsicPut + timeValue).toFixed(2)),
            oi, oiChange: Math.floor((Math.random() - 0.5) * 200000),
            iv: parseFloat(iv.toFixed(2))
        });
    }
    return out;
}

// ============================================================
//  Trade simulator
// ============================================================
// Given a signal, walk forward candles to find which hits first:
//   • SL premium (loss)
//   • T1 premium (partial book) → trail rest with 1×ATR until time-stop
//   • Time-stop at 15:15 IST
// Returns the closed trade record.
function simulateTradeExit(signal, futureCandles) {
    const lotSize = signal.option.lotSize;
    const isCall = signal.side === 'BUY_CALL';
    const delta = signal.option.delta;
    const entryPremium = signal.option.premium;
    const slPrem = signal.option.premiumSL;
    const t1Prem = signal.option.premiumT1;

    let exit = null;
    let exitTime = null;
    let exitReason = null;
    let premiumAtExit = entryPremium;

    for (const c of futureCandles) {
        // Premium estimate: from spot move + delta - small theta bleed
        const spotMove = c.close - signal.spot.entry;
        const directionalPnL = (isCall ? spotMove : -spotMove) * delta;
        const minutesElapsed = (c.time - signal.time / 1000) / 60;
        const thetaBleed = entryPremium * 0.0008 * Math.max(0, minutesElapsed);  // ~0.08%/min theta
        const currentPrem = Math.max(1, entryPremium + directionalPnL - thetaBleed);
        premiumAtExit = currentPrem;

        // Check time-stop
        const istHour = new Date(c.time * 1000).getUTCHours() + 5;
        const istMin = new Date(c.time * 1000).getUTCMinutes() + 30;
        const totalIST = istHour * 60 + istMin;
        if (totalIST >= 15 * 60 + 15) {
            exit = currentPrem;
            exitTime = c.time;
            exitReason = 'TIME_STOP';
            break;
        }

        // Check SL hit (premium dropped below SL)
        if (currentPrem <= slPrem) {
            exit = slPrem;
            exitTime = c.time;
            exitReason = 'SL_HIT';
            break;
        }

        // Check T1 hit
        if (currentPrem >= t1Prem) {
            exit = t1Prem;
            exitTime = c.time;
            exitReason = 'TARGET_HIT';
            break;
        }
    }

    // If futureCandles ran out without exit, exit at last seen price
    if (!exit) {
        exit = premiumAtExit;
        exitTime = futureCandles[futureCandles.length - 1]?.time || signal.time / 1000;
        exitReason = 'END_OF_DATA';
    }

    const lots = signal.sizing.lots;
    const pnl = (exit - entryPremium) * lots * lotSize;

    return {
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        strike: signal.option.strike,
        right: signal.option.right,
        entry: entryPremium,
        exit, exitTime, exitReason,
        lots, quantity: lots * lotSize,
        pnl: parseFloat(pnl.toFixed(2)),
        result: pnl > 0 ? 'WIN' : 'LOSS',
        confidence: signal.confidence,
        tier: signal.tier,
        regime: signal.regime?.regime,
        featureVector: signal.featureVector,
        sessionPhase: signal.session?.phase,
        spotEntry: signal.spot.entry,
        spotExit: futureCandles.find(c => c.time === exitTime)?.close
    };
}

// ============================================================
//  Main backtest runner
// ============================================================
export async function runBacktest({ provider, symbol, timeframe = '5minute', count = 500, accountSize = 500000, riskPercent = 2, confidenceThreshold = 60, mlScorer = null }) {
    console.log(`\n[backtest] ${symbol} ${timeframe} — ${count} candles`);

    const allCandles = await provider.getHistorical(symbol, timeframe, count);
    if (allCandles.length < 100) {
        throw new Error(`Insufficient historical data: ${allCandles.length} candles`);
    }
    console.log(`[backtest] loaded ${allCandles.length} candles`);

    const trades = [];
    const equity = [{ time: allCandles[0].time, value: accountSize }];
    let capital = accountSize;
    const ivHistory = { [symbol]: [] };
    const engine = new SignalEngineV2({
        confidenceThreshold,
        cooldownSec: 0,  // no cooldown in backtest
        mlScorer, ivHistory
    });

    // Walk forward — at each candle close, evaluate signal using
    // ONLY past candles (no look-ahead). If signal fires, simulate exit
    // using *future* candles. Then jump to after the exit.
    let i = 60;  // need 60+ candles of history for multi-TF
    while (i < allCandles.length - 5) {
        const slice = allCandles.slice(0, i + 1);
        const last = slice[slice.length - 1];
        const chain = syntheticChain(last.close, symbol);

        // Track IV history
        const atmRows = chain.filter(o => o.type === 'CE' && Math.abs(o.strike - last.close) < 100);
        if (atmRows.length) {
            const atmIV = atmRows.reduce((a, b) => a + b.iv, 0) / atmRows.length;
            ivHistory[symbol].push(atmIV);
            if (ivHistory[symbol].length > 60) ivHistory[symbol].shift();
        }

        const signal = await engine.evaluate({
            symbol, candles: slice, currentPrice: last.close, chain,
            accountSize: capital, riskPercent, ivHistory,
            evalTime: last.time * 1000,  // historical timestamp, not "now"
            ignoreSession: true           // backtest: evaluate every candle regardless of session
        });

        if (signal.side === 'NO_TRADE') {
            i++;
            continue;
        }

        // Reset engine cooldown so we can still iterate
        engine.lastSignalAt[symbol] = 0;

        // Simulate exit using future candles
        const futureCandles = allCandles.slice(i + 1, Math.min(i + 60, allCandles.length));
        if (futureCandles.length === 0) break;
        signal.time = last.time * 1000;  // override for accurate elapsed-time math

        const trade = simulateTradeExit(signal, futureCandles);
        trades.push(trade);
        capital += trade.pnl;
        equity.push({ time: trade.exitTime, value: parseFloat(capital.toFixed(2)) });

        // Jump to after this trade exit
        const exitIdx = allCandles.findIndex(c => c.time === trade.exitTime);
        i = exitIdx > i ? exitIdx + 1 : i + 5;

        if (trades.length % 20 === 0) {
            console.log(`  ${trades.length} trades, capital ${capital.toFixed(0)}`);
        }
    }

    // ============================================================
    //  Metrics
    // ============================================================
    const wins = trades.filter(t => t.result === 'WIN');
    const losses = trades.filter(t => t.result === 'LOSS');
    const grossProfit = wins.reduce((a, b) => a + b.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
    const winRate = trades.length === 0 ? 0 : (wins.length / trades.length) * 100;
    const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
    const netPnL = capital - accountSize;
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const avgRR = avgLoss === 0 ? 0 : avgWin / avgLoss;

    // Max DD
    let peak = equity[0].value, maxDD = 0;
    for (const p of equity) {
        if (p.value > peak) peak = p.value;
        const dd = (peak - p.value) / peak * 100;
        if (dd > maxDD) maxDD = dd;
    }

    // Sharpe (per-trade returns)
    const tradeReturns = trades.map(t => t.pnl / accountSize);
    const avgRet = tradeReturns.length ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : 0;
    const stdRet = tradeReturns.length
        ? Math.sqrt(tradeReturns.reduce((a, b) => a + Math.pow(b - avgRet, 2), 0) / tradeReturns.length)
        : 0;
    const sharpe = stdRet === 0 ? 0 : (avgRet / stdRet) * Math.sqrt(252);

    // Win rate by tier
    const byTier = {};
    for (const tier of ['HIGH', 'MEDIUM', 'LOW']) {
        const t = trades.filter(x => x.tier === tier);
        const tw = t.filter(x => x.result === 'WIN').length;
        byTier[tier] = { count: t.length, wins: tw, winRate: t.length ? (tw / t.length) * 100 : 0 };
    }

    // Win rate by regime
    const byRegime = {};
    for (const t of trades) {
        const r = t.regime || 'unknown';
        if (!byRegime[r]) byRegime[r] = { count: 0, wins: 0 };
        byRegime[r].count++;
        if (t.result === 'WIN') byRegime[r].wins++;
    }
    for (const r of Object.keys(byRegime)) {
        byRegime[r].winRate = (byRegime[r].wins / byRegime[r].count) * 100;
    }

    const metrics = {
        symbol, timeframe, candlesUsed: allCandles.length,
        startCapital: accountSize,
        endCapital: parseFloat(capital.toFixed(2)),
        netPnL: parseFloat(netPnL.toFixed(2)),
        netReturnPct: parseFloat(((netPnL / accountSize) * 100).toFixed(2)),
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: parseFloat(winRate.toFixed(2)),
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        avgRR: parseFloat(avgRR.toFixed(2)),
        avgWin: parseFloat(avgWin.toFixed(2)),
        avgLoss: parseFloat(avgLoss.toFixed(2)),
        maxDrawdownPct: parseFloat(maxDD.toFixed(2)),
        sharpe: parseFloat(sharpe.toFixed(2)),
        byTier, byRegime
    };

    console.log(`\n[backtest] DONE`);
    console.log(`  Total trades: ${metrics.totalTrades}`);
    console.log(`  Win rate:     ${metrics.winRate}%`);
    console.log(`  Net P&L:      ₹${metrics.netPnL.toLocaleString('en-IN')}`);
    console.log(`  Profit Factor: ${metrics.profitFactor}`);
    console.log(`  Max DD:       ${metrics.maxDrawdownPct}%`);
    console.log(`  Sharpe:       ${metrics.sharpe}`);
    console.log(`  By tier:      ${JSON.stringify(byTier)}`);
    console.log(`  By regime:    ${JSON.stringify(byRegime)}`);

    return { trades, equity, metrics };
}

// ============================================================
//  Export trades as ML training data
// ============================================================
export function exportTrainingData(result, outputPath) {
    const rows = result.trades
        .filter(t => t.featureVector)
        .map(t => ({
            featureVector: t.featureVector,
            result: t.result,
            pnl: t.pnl,
            symbol: t.symbol,
            time: t.exitTime * 1000
        }));
    fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2));
    console.log(`[backtest] exported ${rows.length} training rows → ${outputPath}`);
    return rows.length;
}

// ============================================================
//  CLI runner
// ============================================================
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { createProvider } = await import('./breeze.js');
    const provider = createProvider({ useMock: true });

    const symbol = process.argv[2] || 'NIFTY';
    const tf = process.argv[3] || '5minute';
    const count = parseInt(process.argv[4] || '500', 10);

    const result = await runBacktest({
        provider, symbol, timeframe: tf, count,
        accountSize: 500000, riskPercent: 2,
        confidenceThreshold: 60
    });

    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const outPath = path.join(dataDir, `backtest_${symbol}_${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`[backtest] full result → ${outPath}`);

    const trainPath = path.join(dataDir, `training_${symbol}.json`);
    exportTrainingData(result, trainPath);
}
