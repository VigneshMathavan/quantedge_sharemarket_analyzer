// server/agents/bus.js — Omega Shared Memory & Event Bus
//
// Constitution mandates:
//   "Shared memory: agents read/write a common state"
//   "Shared learning: outcomes update a pool all agents draw from"
//
// What this module provides:
//   1. A single in-process EventEmitter all agents publish/subscribe on
//   2. A mutable `world` object — the shared context every agent can read
//   3. Per-agent vote registry — the Meta Decision agent consumes this
//   4. Persistent snapshot to kv_store so warm restarts keep recent state
//
// Topics (well-known):
//   tick:<SYMBOL>        every observer pass produces a price+candle tick
//   chain:<SYMBOL>       chain-keeper refresh
//   shadow:scored        every shadow_signals insert (REJECT through ELITE)
//   signal:fired         STRONG / ELITE only — surfaced to user
//   outcome:resolved     shadow signal got WIN/LOSS/FLAT
//   trade:closed         real trade recorded in `trades` table
//   regime:changed       market regime classifier flipped
//   agent:vote           any agent publishing a directional vote
//   agent:state          any agent publishing internal state
//   meta:decision        Meta Decision agent's final arbitration
//   alert                Monitoring agent surfacing an anomaly
//
// NOTE: This bus is local-only (in-process). The Omega constitution forbids
// any external broker. If we ever scale to multiple processes, swap the
// EventEmitter for a Redis pub/sub keeping the same API.

import { EventEmitter } from 'events';
import crypto from 'node:crypto';
import { kvGet, kvSet, sysLog } from '../db.js';

const SNAPSHOT_KEY = 'agent_world_snapshot_v1';
const SNAPSHOT_INTERVAL_MS = 30 * 1000;

// Topics that get persisted to Redis Streams for durability & replay.
const DURABLE_TOPICS = new Set([
    'shadow:scored',
    'shadow:resolved',
    'meta:decision',
    'trade:closed',
    'outcome:resolved'
]);

// Optional Redis bridge — activated via BUS_BACKEND=redis (Phase 11)
let _redisAdapter = null;
if ((process.env.BUS_BACKEND || '').toLowerCase() === 'redis') {
    try {
        const mod = await import('./redis-bus-adapter.js');
        _redisAdapter = mod.adapter;
        await _redisAdapter.start();
        sysLog('INFO', 'agent-bus', 'Redis bridge online — cross-process fan-out enabled');
    } catch (e) {
        sysLog('WARN', 'agent-bus', `Redis bridge failed (${e.message}) — falling back to in-process`);
        _redisAdapter = null;
    }
}

class AgentBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);                  // many agents will subscribe

        // ── Idempotency dedup ring-buffer ────────────────────────────────
        this._processedIds = new Set();
        this._processedOrder = [];  // tracks insertion order for ring-buffer eviction

        // ── Shared world state ───────────────────────────────────────────
        // Hot, in-memory. Persisted snapshot every 30s for warm restarts.
        // Restored from kv_store on bus init so agents see the last-known
        // state even if the server bounced.
        this.world = this._loadSnapshot() || {
            market:  {},          // per symbol: { spot, regime, lastTick, sessionPhase }
            signals: {},          // per id: compact signal reference
            agents:  {},          // per agent name: { state, lastVote, lastError, lastTick }
            health:  {            // bus-level health
                startedAt: Date.now(),
                eventCount: 0,
                lastTopic: null,
                lastTs: null
            }
        };

        // Bump health counters on every emit, and bridge to Redis if active.
        const _origEmit = this.emit.bind(this);
        this.emit = (topic, payload, ...rest) => {
            // ── Build envelope (idempotency) ─────────────────────────────
            let envelope;
            if (payload && payload._is_envelope === true) {
                envelope = payload;
            } else {
                envelope = {
                    _is_envelope: true,
                    event_id: crypto.randomUUID(),
                    trace_id: payload?._trace_id || crypto.randomUUID(),
                    correlation_id: payload?._correlation_id || null,
                    causation_id: payload?._causation_id || null,
                    type: topic,
                    timestamp: Date.now(),
                    data: payload
                };
            }

            // ── Dedup check ──────────────────────────────────────────────
            if (this._processedIds.has(envelope.event_id)) {
                return false;   // already processed — skip
            }
            this._processedIds.add(envelope.event_id);
            this._processedOrder.push(envelope.event_id);

            // Ring-buffer eviction: when > 10 000, drop oldest 1 000
            if (this._processedIds.size > 10_000) {
                const toRemove = this._processedOrder.splice(0, 1000);
                for (const id of toRemove) {
                    this._processedIds.delete(id);
                }
            }

            // ── Health counters ──────────────────────────────────────────
            this.world.health.eventCount++;
            this.world.health.lastTopic = topic;
            this.world.health.lastTs = Date.now();

            // ── Redis bridge ─────────────────────────────────────────────
            if (_redisAdapter) {
                try { _redisAdapter.emit(topic, envelope); } catch (_) {}

                // ── Durable stream persistence ───────────────────────────
                if (DURABLE_TOPICS.has(topic)) {
                    const streamKey = `qe:stream:${topic}`;
                    _redisAdapter.addToStream(streamKey, envelope).catch(() => {});
                }
            }

            return _origEmit(topic, envelope, ...rest);
        };

        // If Redis is wired, also pull cross-process events back into the local bus.
        if (_redisAdapter) {
            const topics = ['shadow:scored','shadow:resolved','meta:decision',
                            'agent:vote','agent:state','event:severity-changed'];
            for (const t of topics) {
                _redisAdapter.on(t, (payload) => _origEmit(t, payload));
            }
        }

        this._snapshotTimer = setInterval(() => this._saveSnapshot(),
                                          SNAPSHOT_INTERVAL_MS);

        sysLog('INFO', 'agent-bus',
            `bus online · ${Object.keys(this.world.agents).length} agents in last snapshot`);
    }

    // ─── World accessors ─────────────────────────────────────────────────
    getWorld() { return this.world; }

    setMarket(symbol, partial) {
        if (!symbol) return;
        const cur = this.world.market[symbol] || {};
        this.world.market[symbol] = { ...cur, ...partial, updatedAt: Date.now() };
    }

    getMarket(symbol) {
        return this.world.market[symbol] || null;
    }

    // ─── Per-agent state registry ────────────────────────────────────────
    registerAgent(name, initialState = {}) {
        if (!this.world.agents[name]) {
            this.world.agents[name] = {
                state: initialState,
                lastVote: null,
                lastError: null,
                lastTick: null,
                ticks: 0
            };
        }
        return this.world.agents[name];
    }

    updateAgent(name, partial) {
        if (!this.world.agents[name]) this.registerAgent(name);
        Object.assign(this.world.agents[name], partial, { lastTick: Date.now() });
        this.world.agents[name].ticks++;
    }

    recordVote(name, vote) {
        // vote = { symbol, side, confidence, reason, ts }
        if (!this.world.agents[name]) this.registerAgent(name);
        const traceId = vote.trace_id || crypto.randomUUID();
        this.world.agents[name].lastVote = { ...vote, _trace_id: traceId, ts: Date.now() };
        this.emit('agent:vote', { agent: name, ...vote, _trace_id: traceId, ts: Date.now() });
    }

    getAllVotes(symbol, maxAgeMs = 60_000) {
        // Returns the most-recent vote from each agent for `symbol`, ignoring
        // votes older than maxAgeMs. Used by the Meta Decision agent.
        const now = Date.now();
        const out = [];
        for (const [name, a] of Object.entries(this.world.agents)) {
            const v = a.lastVote;
            if (!v) continue;
            if (symbol && v.symbol !== symbol) continue;
            if (now - (v.ts || 0) > maxAgeMs) continue;
            out.push({ agent: name, ...v });
        }
        return out;
    }

    getAgentStates() {
        // Snapshot for the agents.html dashboard
        const out = {};
        for (const [name, a] of Object.entries(this.world.agents)) {
            out[name] = {
                ticks: a.ticks,
                lastTick: a.lastTick,
                lastError: a.lastError,
                lastVote: a.lastVote,
                state: a.state
            };
        }
        return out;
    }

    // ─── Replay from Redis Streams ───────────────────────────────────────
    /**
     * Re-emit events from a durable Redis Stream for warm restart recovery.
     * @param {string} topic        e.g. "shadow:scored"
     * @param {number} fromTimestamp Unix ms timestamp; events with ts >= this
     *                               are re-emitted locally.
     * @returns {number} count of replayed events
     */
    async replay(topic, fromTimestamp = 0) {
        if (!_redisAdapter) {
            sysLog('WARN', 'agent-bus', 'replay() called but Redis is not active');
            return 0;
        }
        const streamKey = `qe:stream:${topic}`;
        // Redis stream IDs are "<ms>-<seq>", so we can seek by timestamp
        const startId = fromTimestamp ? `${fromTimestamp}-0` : '0-0';
        const entries = await _redisAdapter.readStream(streamKey, startId, 1000);
        const _origEmit = EventEmitter.prototype.emit.bind(this);
        let count = 0;
        for (const entry of entries) {
            if (entry.data && typeof entry.data === 'object') {
                // Emit directly through the original emitter to avoid
                // re-wrapping and re-persisting to the stream.
                _origEmit(topic, entry.data);
                count++;
            }
        }
        sysLog('INFO', 'agent-bus', `replayed ${count} events from ${streamKey}`);
        return count;
    }

    // ─── Snapshot persistence ────────────────────────────────────────────
    _loadSnapshot() {
        try { return kvGet(SNAPSHOT_KEY); } catch { return null; }
    }

    _saveSnapshot() {
        try {
            // Snapshot is a compact copy — drop ephemeral event counters that
            // would balloon the JSON if persisted verbatim.
            const snap = {
                market:  this.world.market,
                agents:  this.world.agents,
                health:  { ...this.world.health }
            };
            kvSet(SNAPSHOT_KEY, snap);
        } catch (e) { sysLog('WARN', 'agent-bus', 'snapshot failed: ' + e.message); }
    }

    shutdown() {
        clearInterval(this._snapshotTimer);
        this._saveSnapshot();
    }
}

// Singleton — the entire process shares one bus.
export const bus = new AgentBus();

// Graceful snapshot on shutdown so warm restart picks up where we left off.
process.on('SIGTERM', () => bus.shutdown());
process.on('SIGINT',  () => { bus.shutdown(); process.exit(0); });
