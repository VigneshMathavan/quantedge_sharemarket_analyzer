// server/history.js — Weekly trade history with auto-reset and disk persistence.
//
// Stores every signal that fired (with full execution + outcome). The current
// week's trades are kept; everything older is archived to data/archive/.
//
// Week = Monday 00:00 IST → next Monday 00:00 IST.
//
// On boot:
//   • Load data/week-trades.json
//   • If its weekKey != current week, archive the file and start fresh
//
// Auto-archive is also re-checked on every write, so the file rolls forward
// even if the backend runs across a week boundary.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const STORE_PATH = path.join(DATA_DIR, 'week-trades.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// ============================================================
//  Week key — Monday-start ISO week in IST
// ============================================================
function currentWeekKey(now = Date.now()) {
    // Convert to IST
    const ist = new Date(now + (5 * 60 + 30) * 60 * 1000);
    // ISO weekday: Mon=1 ... Sun=7
    const weekday = ist.getUTCDay() === 0 ? 7 : ist.getUTCDay();
    // Roll back to Monday 00:00 IST
    const mondayIst = new Date(ist);
    mondayIst.setUTCDate(mondayIst.getUTCDate() - (weekday - 1));
    mondayIst.setUTCHours(0, 0, 0, 0);
    const y = mondayIst.getUTCFullYear();
    const m = String(mondayIst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(mondayIst.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function weekRange(weekKey) {
    const [y, m, d] = weekKey.split('-').map(Number);
    const start = Date.UTC(y, m - 1, d) - (5 * 60 + 30) * 60 * 1000;
    const end = start + 7 * 24 * 3600 * 1000;
    return { startMs: start, endMs: end };
}

// ============================================================
//  Store
// ============================================================
class HistoryStore {
    constructor() {
        this.weekKey = currentWeekKey();
        this.trades = [];
        this._load();
    }

    _load() {
        try {
            if (!fs.existsSync(STORE_PATH)) return;
            const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
            if (j.weekKey === this.weekKey) {
                this.trades = j.trades || [];
            } else {
                // Roll forward — archive old week
                this._archive(j);
            }
        } catch (e) {
            console.error('[history] load failed:', e.message);
        }
    }

    _archive(oldData) {
        try {
            const archivePath = path.join(ARCHIVE_DIR, `week-${oldData.weekKey}.json`);
            fs.writeFileSync(archivePath, JSON.stringify(oldData, null, 2));
            console.log(`[history] archived ${oldData.trades?.length || 0} trades to ${path.basename(archivePath)}`);
        } catch (e) {
            console.error('[history] archive failed:', e.message);
        }
    }

    _save() {
        try {
            const payload = {
                weekKey: this.weekKey,
                weekRange: weekRange(this.weekKey),
                tradeCount: this.trades.length,
                updatedAt: Date.now(),
                trades: this.trades
            };
            fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2));
        } catch (e) {
            console.error('[history] save failed:', e.message);
        }
    }

    _checkRollover() {
        const nowKey = currentWeekKey();
        if (nowKey !== this.weekKey) {
            this._archive({ weekKey: this.weekKey, trades: this.trades });
            this.weekKey = nowKey;
            this.trades = [];
            this._save();
        }
    }

    addTrade(trade) {
        this._checkRollover();
        // Normalize shape so frontend has a consistent contract
        const t = {
            id: trade.id || 'tr_' + Math.random().toString(16).slice(2, 10),
            time: trade.time || Date.now(),            // entry time ms
            exitTime: trade.exitTime || null,           // exit time ms
            symbol: trade.symbol,
            side: trade.side,                           // BUY_CALL | BUY_PUT
            strike: trade.strike,
            right: trade.right,                         // CE | PE
            confidence: trade.confidence,
            tier: trade.tier,
            regime: trade.regime,
            entry: trade.entry,                         // entry premium
            exit: trade.exit,                           // exit premium
            stopLoss: trade.stopLoss,
            target1: trade.target1,
            target2: trade.target2,
            lots: trade.lots,
            quantity: trade.quantity,
            pnl: trade.pnl,
            costs: trade.costs || 0,
            result: trade.result,                       // WIN | LOSS
            exitReason: trade.exitReason,               // SL_HIT | TARGET_HIT | TIME_STOP
            spotEntry: trade.spotEntry,
            spotExit: trade.spotExit,
            source: trade.source || 'live'              // live | replay | backtest
        };
        this.trades.push(t);
        this._save();
        return t;
    }

    addBatch(trades) {
        this._checkRollover();
        let added = 0;
        for (const t of trades) {
            this.addTrade(t);
            added++;
        }
        return added;
    }

    list() {
        this._checkRollover();
        return this.trades.slice().sort((a, b) => (b.time || 0) - (a.time || 0));
    }

    summary() {
        this._checkRollover();
        const wins = this.trades.filter(t => t.result === 'WIN');
        const losses = this.trades.filter(t => t.result === 'LOSS');
        const netPnL = this.trades.reduce((a, b) => a + (b.pnl || 0), 0);
        const grossWin = wins.reduce((a, b) => a + (b.pnl || 0), 0);
        const grossLoss = Math.abs(losses.reduce((a, b) => a + (b.pnl || 0), 0));
        const wr = this.trades.length ? (wins.length / this.trades.length) * 100 : 0;
        const pf = grossLoss === 0 ? grossWin : grossWin / grossLoss;
        const bestTrade = this.trades.reduce((m, t) => (!m || t.pnl > m.pnl) ? t : m, null);
        const worstTrade = this.trades.reduce((m, t) => (!m || t.pnl < m.pnl) ? t : m, null);
        return {
            weekKey: this.weekKey,
            weekRange: weekRange(this.weekKey),
            tradeCount: this.trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: parseFloat(wr.toFixed(2)),
            netPnL: parseFloat(netPnL.toFixed(2)),
            grossWin: parseFloat(grossWin.toFixed(2)),
            grossLoss: parseFloat(grossLoss.toFixed(2)),
            profitFactor: parseFloat(pf.toFixed(2)),
            bestTrade: bestTrade ? { strike: bestTrade.strike, right: bestTrade.right, pnl: bestTrade.pnl } : null,
            worstTrade: worstTrade ? { strike: worstTrade.strike, right: worstTrade.right, pnl: worstTrade.pnl } : null
        };
    }

    clear() {
        this.trades = [];
        this._save();
    }

    // Retention sweep — user wants trades visible until 16:00 IST, then
    // pruned so the in-memory store doesn't bloat. Called daily.
    pruneOlderThanDays(days = 1) {
        const cutoff = Date.now() - days * 86400 * 1000;
        const before = this.trades.length;
        this.trades = this.trades.filter(t => (t.exitTime || t.time || 0) >= cutoff);
        if (this.trades.length !== before) {
            console.log(`[history] retention sweep removed ${before - this.trades.length} trades older than ${days}d`);
            this._save();
        }
    }
}

export const history = new HistoryStore();

// ────────────────────────────────────────────────────────────────
//  Daily retention sweep at 16:00 IST (30 min after market close)
//  Keeps yesterday's trades for review, prunes anything > 24h old.
//  Runs once per minute checking if we just crossed 16:00 IST.
// ────────────────────────────────────────────────────────────────
let _lastPruneDate = null;
setInterval(() => {
    const istMs = Date.now() + (5*60+30) * 60000;
    const ist = new Date(istMs);
    const istHour = ist.getUTCHours();
    const istMin = ist.getUTCMinutes();
    const istDate = ist.toISOString().slice(0, 10);
    if (istHour === 16 && istMin === 0 && _lastPruneDate !== istDate) {
        _lastPruneDate = istDate;
        history.pruneOlderThanDays(1);   // keep last 24h
    }
}, 60 * 1000);

export { currentWeekKey, weekRange };
