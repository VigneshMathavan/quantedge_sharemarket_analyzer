// server/strategies/bootstrap-model.js — Train win-prob model from backtest data.
//
// Pipeline:
//   1. Load 5yr daily data for NIFTY + SENSEX + FINNIFTY (already in data/)
//   2. Walk through each symbol with Strategy v2 engine to generate trades
//      → each trade comes with its featureVector + WIN/LOSS outcome
//   3. Pool all trades into one labeled dataset
//   4. Train logistic regression (300 epochs, validate hold-out 20%)
//   5. Save model to data/win-prob-model.json
//
// Run:
//   node strategies/bootstrap-model.js
//
// Output: ML-scoring ready from day 1 of live trading.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StrategyV2Engine } from '../strategy/v2-overrides.js';
import { trainModel, winProbModel, FEATURES } from './win-prob.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// SEBI Nov 2024 revised lot sizes
const SYMBOL_META = {
    NIFTY:     { lot_size: 75, strike_gap: 50 },
    SENSEX:    { lot_size: 20, strike_gap: 100 },
    FINNIFTY:  { lot_size: 65, strike_gap: 50 }
};

function syntheticChain(spot, symbol, vix = 14) {
    const gap = SYMBOL_META[symbol].strike_gap;
    const atm = Math.round(spot / gap) * gap;
    const out = [];
    for (let i = -8; i <= 8; i++) {
        const strike = atm + i * gap;
        const dist = Math.abs(i);
        const ce = Math.max(0, spot - strike);
        const pe = Math.max(0, strike - spot);
        const tv = Math.max(5, (spot * 0.005) / (1 + dist * 0.35));
        const oi = Math.floor((900000 + Math.random() * 1500000) / (1 + dist * 0.25));
        const iv = vix * 0.9 + dist * 0.4;
        out.push({ strike, type: 'CE', ltp: parseFloat((ce + tv).toFixed(2)), oi, iv: parseFloat(iv.toFixed(2)), oiChange: 0 });
        out.push({ strike, type: 'PE', ltp: parseFloat((pe + tv).toFixed(2)), oi, iv: parseFloat(iv.toFixed(2)), oiChange: 0 });
    }
    return out;
}

function simulateExit(signal, future) {
    const lotSize = signal.option.lotSize;
    const isCall = signal.side === 'BUY_CALL';
    const delta = signal.option.delta;
    const entry = signal.option.premium;
    const sl = signal.option.premiumSL;
    const t1 = signal.option.premiumT1;
    let exitPrem = entry, exitReason = 'TIME_STOP';
    let exitIdx = -1;
    for (let i = 0; i < future.length; i++) {
        const c = future[i];
        const spotMove = c.close - signal.spot.entry;
        const dPnL = (isCall ? spotMove : -spotMove) * delta;
        const minutes = (c.time - signal.time / 1000) / 60;
        const theta = entry * 0.0008 * Math.max(0, minutes);
        const cur = Math.max(0.5, entry + dPnL - theta);
        exitPrem = cur;
        if (cur <= sl) { exitPrem = sl; exitReason = 'SL_HIT'; exitIdx = i; break; }
        if (cur >= t1) { exitPrem = t1; exitReason = 'TARGET_HIT'; exitIdx = i; break; }
    }
    const pnl = (exitPrem - entry) * signal.sizing.lots * lotSize;
    return { exitPrem, exitReason, pnl, exitIdx, result: pnl > 0 ? 'WIN' : 'LOSS' };
}

async function generateTrades(symbol, candles) {
    const trades = [];
    const engine = new StrategyV2Engine({
        cooldownSec: 0, confLower: 50, confUpper: 70,
        skipTrendingUp: true, ivHistory: { [symbol]: [] }
    });

    let i = 60;
    while (i < candles.length - 30) {
        const slice = candles.slice(Math.max(0, i - 200), i + 1);
        const last = slice[slice.length - 1];
        const chain = syntheticChain(last.close, symbol);
        const atmRows = chain.filter(o => o.type === 'CE' && Math.abs(o.strike - last.close) < 100);
        if (atmRows.length) {
            const atmIV = atmRows.reduce((a, b) => a + b.iv, 0) / atmRows.length;
            engine.engine.opts.ivHistory[symbol].push(atmIV);
            if (engine.engine.opts.ivHistory[symbol].length > 60) engine.engine.opts.ivHistory[symbol].shift();
        }
        const sig = await engine.evaluate({
            symbol, candles: slice, currentPrice: last.close, chain,
            accountSize: 500000, riskPercent: 1.5,
            ivHistory: engine.engine.opts.ivHistory
        });
        if (sig.side === 'NO_TRADE') { i++; continue; }
        engine.engine.lastSignalAt[symbol] = 0;
        sig.time = last.time * 1000;
        const future = candles.slice(i + 1, i + 30);
        if (!future.length) break;
        const out = simulateExit(sig, future);

        // Build the featureVector — mirror what live confluence will produce
        const fv = sig.featureVector || {};
        trades.push({
            featureVector: {
                confidence_raw: sig.confidence,
                callScore: sig.side === 'BUY_CALL' ? sig.confidence : 0,
                putScore: sig.side === 'BUY_PUT' ? sig.confidence : 0,
                newsScore: 0,  // no historical news scores
                rsiV5: fv.rsiV5 || 50,
                atrPct: fv.atrPct || 0,
                adxV: fv.adxV || 20,
                volRatio: fv.volRatio || 1,
                pcr: fv.pcr || 1,
                atmIV: fv.atmIV || 15,
                ivPct: fv.ivPct || 50,
                side: sig.side,
                regime: sig.regime?.regime,
                sessionPhase: sig.session?.phase || 'morning',
                tier: sig.tier
            },
            result: out.result,
            pnl: out.pnl,
            symbol
        });

        i += (out.exitIdx >= 0 ? out.exitIdx + 2 : 3);
    }
    return trades;
}

async function main() {
    console.log('═'.repeat(70));
    console.log('  QuantEdge Win-Prob Model — Bootstrap Training');
    console.log('═'.repeat(70));
    console.log();
    console.log('Phase 1: Generating labeled trades from backtest data...');

    const allTrades = [];
    for (const [symbol, tf] of [
        ['NIFTY', '1day'], ['NIFTY', '5minute'],
        ['SENSEX', '1day'], ['SENSEX', '5minute'],
        ['FINNIFTY', '5minute']
    ]) {
        const p = path.join(DATA_DIR, `${symbol}_${tf}.json`);
        if (!fs.existsSync(p)) {
            console.log(`  · ${symbol} ${tf}: data file not found — skip`);
            continue;
        }
        const candles = JSON.parse(fs.readFileSync(p, 'utf-8'));
        process.stdout.write(`  · ${symbol} ${tf}: ${candles.length} candles → generating trades... `);
        const trades = await generateTrades(symbol, candles);
        const wins = trades.filter(t => t.result === 'WIN').length;
        console.log(`${trades.length} trades (${wins} W / ${trades.length - wins} L)`);
        allTrades.push(...trades);
    }

    console.log();
    console.log(`Phase 2: Total dataset = ${allTrades.length} samples`);
    if (allTrades.length < 50) {
        console.log('  ⚠ Too few samples to train. Increase backtest data.');
        process.exit(1);
    }
    const wins = allTrades.filter(t => t.result === 'WIN').length;
    console.log(`  Win rate: ${(wins / allTrades.length * 100).toFixed(1)}%`);

    console.log();
    console.log('Phase 3: Training logistic regression...');
    const model = trainModel(allTrades, { epochs: 400, lr: 0.05, verbose: true });

    console.log();
    console.log('═'.repeat(70));
    console.log('  TRAINING COMPLETE');
    console.log('═'.repeat(70));
    console.log(`  Samples:    ${model.sampleCount}`);
    console.log(`  Train Acc:  ${(model.trainAcc * 100).toFixed(2)}%`);
    console.log(`  Val Acc:    ${(model.valAcc * 100).toFixed(2)}%`);
    console.log(`  Val LogLoss:${model.valLogloss.toFixed(4)}`);
    console.log();
    console.log('  Top 5 features by absolute weight:');
    model.topFeatures.forEach((f, i) => {
        console.log(`    ${i + 1}. ${f.name.padEnd(28)} ${f.weight >= 0 ? '+' : ''}${f.weight}`);
    });
    console.log();

    winProbModel.setModel(model);
    console.log(`  Model saved → data/win-prob-model.json`);
    console.log(`  Ready for live inference. Online updates kick in after every closed trade.`);
}

main().catch(e => { console.error(e); process.exit(1); });
