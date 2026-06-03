// server/seed-backtest.js — Mass historical backtest seeder.
//
// Master-spec requirement: "All calculations, backtests of all the
// indices for 10 yrs with every time frame is mandatory."
//
// Walks every (symbol, timeframe) pair on disk:
//   • Loads candles from data/historical/SYMBOL_TF.json
//   • Slides a 200-bar window across the series
//   • Runs the existing StrategyOrchestrator on each window
//   • Records every actionable signal to signal_journal (SQLite)
//   • Simulates the trade outcome (SL/T1/T2 hit) over next 20 bars
//   • Records the simulated trade to trades table
//
// Output: ten thousand+ historical signals + outcomes that:
//   1. Power the similarity matcher from day one
//   2. Seed the factor learner with real correlation data
//   3. Populate the 10-year backtest stats per strategy
//
// Idempotent: detects existing seed by source='backtest_seed' marker
// and skips. Re-run with `--force` to wipe and reseed.
//
//   Usage: node seed-backtest.js [--force] [--symbol NIFTY] [--tf 5minute]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StrategyOrchestrator } from './strategies/base.js';
import { orbStrategy } from './strategies/orb.js';
import { vwapContinuationStrategy } from './strategies/vwap-continuation.js';
import { supertrendEmaStrategy } from './strategies/supertrend-ema.js';
import { rsiReversionStrategy } from './strategies/rsi-reversion.js';
import { bbSqueezeStrategy } from './strategies/bb-squeeze.js';
import { momentumBurstStrategy } from './strategies/momentum-burst.js';
import { rangeExpansionStrategy } from './strategies/range-expansion.js';
import { insideBarStrategy } from './strategies/inside-bar.js';
import { vwapCrossStrategy } from './strategies/vwap-cross.js';
import { emaPullbackStrategy } from './strategies/ema-pullback.js';
import { volumeClimaxStrategy } from './strategies/volume-climax.js';
import { cprBreakoutStrategy, cprReversalStrategy } from './strategies/cpr-strategy.js';
import { computeAllParameters, computeFactorScores } from './parameter-engine.js';
import { saveTrade, logSignal, sysLog, db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HIST_DIR = path.join(__dirname, '..', 'data', 'historical');

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];
const TFS = ['1day', '60minute', '30minute', '15minute', '5minute', '3minute', '1minute'];

// Window size + step — bigger window = better indicator quality,
// bigger step = faster but fewer samples. Default: 200-bar window,
// 5-bar step (samples every 5 closed candles).
const WINDOW = 200;
const STEP = 5;

const orchestrator = new StrategyOrchestrator([
    orbStrategy, vwapContinuationStrategy, supertrendEmaStrategy,
    rsiReversionStrategy, bbSqueezeStrategy, momentumBurstStrategy,
    rangeExpansionStrategy, insideBarStrategy, vwapCrossStrategy,
    emaPullbackStrategy, volumeClimaxStrategy,
    cprBreakoutStrategy, cprReversalStrategy
]);

// ──────────────────────────────────────────────────────────────────
//  Trade outcome simulator — walks next N candles after entry to
//  determine which of {SL, T1, T2, TIMEOUT} hits first.
//  Uses spot-based SL/T1/T2 derived from ATR + signal direction.
// ──────────────────────────────────────────────────────────────────
function simulateOutcome(entryCandle, futureBars, side, atrV) {
    if (!futureBars.length) return null;
    const entry = entryCandle.close;
    const direction = side === 'BUY_CALL' ? 1 : -1;
    // Same ATR-based bracket as the live strike-scanner uses
    const slDist = atrV * 1.0;
    const t1Dist = atrV * 2.0;
    const t2Dist = atrV * 3.5;
    const sl = entry - slDist * direction;
    const t1 = entry + t1Dist * direction;
    const t2 = entry + t2Dist * direction;

    for (let i = 0; i < futureBars.length; i++) {
        const c = futureBars[i];
        // For long: SL hit if low ≤ sl, T1 hit if high ≥ t1
        // For short: SL hit if high ≥ sl, T1 hit if low ≤ t1
        const slHit = direction === 1 ? c.low <= sl : c.high >= sl;
        const t1Hit = direction === 1 ? c.high >= t1 : c.low <= t1;
        const t2Hit = direction === 1 ? c.high >= t2 : c.low <= t2;

        if (slHit) {
            return {
                result: 'LOSS', exitReason: 'SL_HIT',
                exitPrice: sl, exitIdx: i,
                pnl: -slDist * direction * (direction === 1 ? 1 : -1)
            };
        }
        if (t2Hit) {
            return {
                result: 'WIN', exitReason: 'T2_HIT',
                exitPrice: t2, exitIdx: i,
                pnl: t2Dist
            };
        }
        if (t1Hit) {
            return {
                result: 'WIN', exitReason: 'T1_HIT',
                exitPrice: t1, exitIdx: i,
                pnl: t1Dist
            };
        }
    }
    // Timeout — flat exit at last bar
    const last = futureBars[futureBars.length - 1];
    const movePct = ((last.close - entry) * direction);
    return {
        result: movePct > 0 ? 'WIN' : movePct < 0 ? 'LOSS' : 'FLAT',
        exitReason: 'TIMEOUT',
        exitPrice: last.close, exitIdx: futureBars.length - 1,
        pnl: movePct
    };
}

// ──────────────────────────────────────────────────────────────────
//  Walk a single (symbol, tf) series
// ──────────────────────────────────────────────────────────────────
async function processSeries(symbol, tf) {
    const filePath = path.join(HIST_DIR, `${symbol}_${tf}.json`);
    if (!fs.existsSync(filePath)) {
        console.log(`  ⏭  ${symbol} ${tf}: no data file`);
        return { signals: 0, trades: 0 };
    }

    const candles = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (candles.length < WINDOW + 25) {
        console.log(`  ⏭  ${symbol} ${tf}: only ${candles.length} candles (need ${WINDOW + 25})`);
        return { signals: 0, trades: 0 };
    }

    let signals = 0, trades = 0;
    const totalIterations = Math.floor((candles.length - WINDOW - 25) / STEP);
    let iteration = 0;
    let lastReport = Date.now();

    for (let i = WINDOW; i < candles.length - 25; i += STEP) {
        iteration++;
        const window = candles.slice(i - WINDOW, i);
        const future = candles.slice(i, i + 25);

        let result;
        try {
            result = await orchestrator.evaluate({
                candles: window, vix: 15, eventGate: { ok: true },
                newsSentiment: null, mlScorer: null
            });
        } catch { continue; }

        if (!result || result.side === 'NO_TRADE') continue;
        const firing = (result.votes || []).filter(v => v.fired);
        if (firing.length === 0) continue;

        const params = computeAllParameters({ candles: window, chain: null, spot: window[window.length - 1].close });
        const factorScores = computeFactorScores(params, result.side);

        const entryCandle = window[window.length - 1];
        const atrV = params.volatility?.atr14 || (entryCandle.high - entryCandle.low);
        const outcome = simulateOutcome(entryCandle, future, result.side, atrV);
        if (!outcome) continue;

        const signalRecord = {
            ts: entryCandle.time * 1000,
            symbol, side: result.side,
            tier: firing.length >= 3 ? 'STRONG' : firing.length >= 2 ? 'LIKELY' : 'POTENTIAL',
            confluenceScore: result.confluenceScore,
            regime: result.regime?.regime || null,
            firingStrategies: firing.map(v => ({ id: v.id, name: v.name, score: v.weight })),
            priceContext: { close: entryCandle.close, high: entryCandle.high, low: entryCandle.low, volume: entryCandle.volume },
            parameters: params,
            actionable: {
                strike: Math.round(entryCandle.close / 50) * 50,
                right: result.side === 'BUY_CALL' ? 'CE' : 'PE',
                premium: entryCandle.close * 0.02,   // rough proxy — only used for chart spacing
                factorScores
            },
            factorScores,
            source: 'backtest_seed',
            tf
        };
        logSignal(signalRecord);
        signals++;

        const tradeId = `seed_${symbol}_${tf}_${entryCandle.time}`;
        const tradeRecord = {
            id: tradeId,
            time: entryCandle.time * 1000,
            exitTime: future[outcome.exitIdx].time * 1000,
            symbol, side: result.side,
            strike: signalRecord.actionable.strike,
            right: signalRecord.actionable.right,
            entry: entryCandle.close,
            exit: outcome.exitPrice,
            pnl: Math.round(outcome.pnl * 100),
            result: outcome.result,
            exitReason: outcome.exitReason,
            tier: signalRecord.tier,
            confidence: result.confluenceScore,
            regime: signalRecord.regime,
            firingStrategies: signalRecord.firingStrategies,
            source: 'backtest_seed',
            option: { lotSize: 65, strike: signalRecord.actionable.strike, right: signalRecord.actionable.right, premium: entryCandle.close * 0.02 },
            sizing: { lots: 1, quantity: 65, capitalRequired: 0, maxLoss: 0 }
        };
        saveTrade(tradeRecord);
        trades++;

        if (Date.now() - lastReport > 3000) {
            const pct = ((iteration / totalIterations) * 100).toFixed(1);
            process.stdout.write(`\r    ${symbol} ${tf.padEnd(9)} ${pct.padStart(5)}% · ${signals} signals · ${trades} trades`);
            lastReport = Date.now();
        }
    }
    console.log(`\n  ✓ ${symbol} ${tf}: ${signals} signals · ${trades} trades`);
    return { signals, trades };
}

// ──────────────────────────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const onlySymbol = args.includes('--symbol') ? args[args.indexOf('--symbol') + 1] : null;
    const onlyTf = args.includes('--tf') ? args[args.indexOf('--tf') + 1] : null;

    // Skip if already seeded (unless --force)
    const existingSeed = db.prepare(`SELECT COUNT(*) c FROM trades WHERE source = 'backtest_seed'`).get();
    if (existingSeed.c > 0 && !force) {
        console.log(`[seed] already seeded with ${existingSeed.c} trades. Use --force to wipe + reseed.`);
        process.exit(0);
    }
    if (force) {
        const deleted = db.prepare(`DELETE FROM trades WHERE source = 'backtest_seed'`).run().changes;
        const deletedSig = db.prepare(`DELETE FROM signal_journal WHERE full_json LIKE '%backtest_seed%'`).run().changes;
        console.log(`[seed] --force: deleted ${deleted} seed trades, ${deletedSig} seed signals`);
    }

    const symbols = onlySymbol ? [onlySymbol] : SYMBOLS;
    const tfs = onlyTf ? [onlyTf] : TFS;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  QUANTEDGE MASS BACKTEST SEEDER');
    console.log(`  ${symbols.length} symbols × ${tfs.length} TFs × 13 strategies`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const start = Date.now();
    const totals = { signals: 0, trades: 0 };
    for (const symbol of symbols) {
        console.log(`\n━━━ ${symbol} ━━━`);
        for (const tf of tfs) {
            const r = await processSeries(symbol, tf);
            totals.signals += r.signals;
            totals.trades += r.trades;
        }
    }
    const tookMin = ((Date.now() - start) / 60000).toFixed(1);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✓ COMPLETE — ${totals.signals.toLocaleString()} signals · ${totals.trades.toLocaleString()} trades in ${tookMin} min`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    sysLog('INFO', 'seed-backtest', `seeded ${totals.signals} signals + ${totals.trades} trades in ${tookMin}min`);
}

main().catch(e => { console.error(e); process.exit(1); });
