// server/strategy/v2-overrides.js — Strategy v2 (opportunistic mode).
//
// REVISED 2026-05-29: Removed the aggressive filters that were artificially
// suppressing signal count to "1 every 90 min". The original goal was high
// per-signal quality, but a tool that produces zero signals during a live
// session is unusable. New philosophy:
//
//   PHILOSOPHY:  Always be ready to fire. The edge is loss minimization,
//                not signal scarcity. If a tradeable setup exists, surface it.
//                Each signal is tagged with quality info so the user can
//                triage the marginal ones.
//
// What we still do:
//   • Premium-based SL / time-stop (15:15 IST hard exit)
//   • Position size capped at riskPercent of capital
//   • Show full reasoning so user can override individual signals
//
// What we REMOVED (vs old v2):
//   • Confidence upper cap (was 70) — too brittle, removed entirely
//   • Skip trending_up regime — replaced with smaller size hint
//   • Long cooldown — was 90s, now 30s (just enough to avoid duplicate fires)

import { SignalEngineV2 } from '../signal2.js';

export class StrategyV2Engine {
    constructor(opts = {}) {
        // Inner engine fires on lower threshold so we see every candidate
        this.engine = new SignalEngineV2({
            confidenceThreshold: opts.innerThreshold ?? 30,
            cooldownSec: opts.cooldownSec ?? 30,
            mlScorer: opts.mlScorer || null,
            ivHistory: opts.ivHistory || {},
            recentTrades: opts.recentTrades || []
        });
        this.opts = {
            // Floor only — no upper cap
            confLower: opts.confLower ?? 35,
            // Quality tagging
            qualityHigh: opts.qualityHigh ?? 65,
            qualityMedium: opts.qualityMedium ?? 50,
            // Regime hints (no hard-block, no time-of-day dampening).
            // Full-force trading 9:15-3:30 IST — global session overlaps
            // (London open ~12:30 IST, US pre-market ~14:00 IST) often
            // bring fresh momentum that we don't want to miss.
            sizeMultTrendingUp: opts.sizeMultTrendingUp ?? 1.0,    // no penalty
            sizeMultLunch:      opts.sizeMultLunch      ?? 1.0,    // no penalty
            sizeMultLateDay:    opts.sizeMultLateDay    ?? 1.0,    // no penalty
            preferITM1Threshold: opts.preferITM1Threshold ?? 50
        };
        this.lastSignalAt = this.engine.lastSignalAt;
    }

    async evaluate(args) {
        const raw = await this.engine.evaluate(args);
        if (raw.side === 'NO_TRADE') return raw;

        const reasons = [];
        const warnings = [];
        let blocked = false;
        let sizeMult = 1.0;

        // Only one HARD gate: confidence floor
        if (raw.confidence < this.opts.confLower) {
            blocked = true;
            reasons.push(`conf ${raw.confidence} below floor ${this.opts.confLower}`);
        }

        // Soft warnings — fire AND keep full size. Note risk but trust the
        // approval engine + regime + path forecaster to make the final call.
        const regime = raw.regime?.regime;
        if (regime === 'trending_up' && raw.side === 'BUY_PUT') {
            warnings.push('⚠ trending_up regime — fading the trend');
        }
        if (regime === 'trending_down' && raw.side === 'BUY_CALL') {
            warnings.push('⚠ trending_down regime — fading the trend');
        }
        // Lunch / late-session warnings DROPPED entirely. Global sessions
        // (London open ~12:30 IST, US pre-market ~14:00 IST) bring volume.

        // Quality tag (not blocking — informational)
        let qualityTag = 'C';
        if (raw.confidence >= this.opts.qualityHigh) qualityTag = 'A';
        else if (raw.confidence >= this.opts.qualityMedium) qualityTag = 'B';

        if (blocked) {
            return {
                ...raw,
                side: 'NO_TRADE',
                strategyVersion: 'v2-opportunistic',
                blockedReasons: reasons
            };
        }

        // Apply size multiplier — reduce lots proportionally
        if (raw.sizing && sizeMult < 1.0) {
            const origLots = raw.sizing.lots;
            raw.sizing.lots = Math.max(1, Math.floor(origLots * sizeMult));
            raw.sizing.quantity = raw.sizing.lots * (raw.option?.lotSize || 25);
            raw.sizing.capitalRequired = Math.round(raw.sizing.lots * (raw.option?.lotSize || 25) * (raw.option?.premium || 100));
            raw.sizing.maxLoss = Math.round(raw.sizing.lots * (raw.option?.lotSize || 25) *
                Math.max(1, (raw.option?.premium || 100) - (raw.option?.premiumSL || 50)));
            raw.sizing.sizeMultApplied = parseFloat(sizeMult.toFixed(2));
        }

        // Strike hint for marginal signals
        if (raw.confidence < this.opts.preferITM1Threshold && raw.option) {
            raw.option.preferITM1 = true;
            raw.option.rationale = (raw.option.rationale || '') + ' [v2 hint: prefer ITM-1 for marginal setup]';
        }

        return {
            ...raw,
            strategyVersion: 'v2-opportunistic',
            qualityTag,
            warnings,
            sizeMult
        };
    }
}
