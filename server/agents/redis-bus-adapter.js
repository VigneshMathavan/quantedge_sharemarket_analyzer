// server/agents/redis-bus-adapter.js
//
// Opt-in distributed bus. Activated when:
//   BUS_BACKEND=redis   AND   REDIS_URL=<connection string>
//
// Install steps (user action):
//   1. Install Redis 7+ locally (Windows: use the Memurai installer, or
//      Docker:  docker run -d -p 6379:6379 --name qe-redis redis:7)
//   2. cd D:\Projects\quantedge\server && npm install ioredis
//   3. Set REDIS_URL=redis://localhost:6379 in .env
//   4. Restart — the bus auto-promotes from in-process EventEmitter to Redis
//
// The adapter exposes the SAME interface as the in-process bus
// (emit / on / setMaxListeners) plus a teardown.

import { EventEmitter } from 'events';

let _pub = null, _sub = null;
let _connected = false;
let _startedAt = null;
let _reconnectTimer = null;
let _reconnectDelay = 1000;       // start at 1 s
const MAX_RECONNECT_DELAY = 30000; // cap at 30 s

const _local = new EventEmitter();
_local.setMaxListeners(200);

// ── Internal reconnection with exponential backoff ──────────────────────
function _scheduleReconnect() {
    if (_reconnectTimer) return;          // already scheduled
    _reconnectTimer = setTimeout(async () => {
        _reconnectTimer = null;
        try {
            await _connect();
            _reconnectDelay = 1000;       // reset on success
        } catch (_) {
            // double the delay, capped at MAX_RECONNECT_DELAY
            _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT_DELAY);
            _scheduleReconnect();
        }
    }, _reconnectDelay);
}

function _attachConnectionHandlers(client, label) {
    client.on('error', (err) => {
        _connected = false;
        // Avoid noisy logs — just schedule reconnect
        _scheduleReconnect();
    });
    client.on('close', () => {
        _connected = false;
        _scheduleReconnect();
    });
    client.on('ready', () => {
        // Both clients must be ready
        if (_pub?.status === 'ready' && _sub?.status === 'ready') {
            _connected = true;
        }
    });
}

async function _connect() {
    if (_pub && _sub && _connected) return;

    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is not set');
    let IORedis;
    try {
        IORedis = (await import('ioredis')).default;
    } catch (e) {
        throw new Error('npm install ioredis required for Redis bus backend');
    }

    // Clean up any prior sockets before reconnecting
    if (_pub) { try { _pub.disconnect(); } catch (_) {} }
    if (_sub) { try { _sub.disconnect(); } catch (_) {} }

    _pub = new IORedis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
    _sub = new IORedis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });

    _attachConnectionHandlers(_pub, 'pub');
    _attachConnectionHandlers(_sub, 'sub');

    // Forward Redis messages to the local EventEmitter so the rest of the
    // codebase doesn't care which backend is in use.
    _sub.on('pmessage', (_pat, channel, payload) => {
        try { _local.emit(channel, JSON.parse(payload)); }
        catch (_) { _local.emit(channel, payload); }
    });
    _sub.psubscribe('qe:*');

    _connected = true;
    if (!_startedAt) _startedAt = Date.now();
}

// ── Redis Streams helpers ───────────────────────────────────────────────

/**
 * XADD — append an event to a Redis Stream.
 * @param {string} streamKey  e.g. "qe:stream:shadow:scored"
 * @param {object} eventData  arbitrary JSON-serialisable object
 * @returns {string|null} the stream message ID, or null on failure
 */
async function addToStream(streamKey, eventData) {
    if (!_pub || !_connected) return null;
    try {
        return await _pub.xadd(streamKey, '*', 'data', JSON.stringify(eventData));
    } catch (_) { return null; }
}

/**
 * XREAD — read entries from a stream starting after `lastId`.
 * @param {string} streamKey
 * @param {string} lastId     e.g. "0-0" for beginning
 * @param {number} count      max entries to return
 * @returns {Array}  array of { id, data } or []
 */
async function readStream(streamKey, lastId = '0-0', count = 100) {
    if (!_pub || !_connected) return [];
    try {
        const result = await _pub.xread('COUNT', count, 'STREAMS', streamKey, lastId);
        if (!result) return [];
        // result: [ [ streamKey, [ [id, [field, value, ...]], ... ] ] ]
        const entries = result[0][1];
        return entries.map(([id, fields]) => {
            // fields is [field1, value1, field2, value2, ...]
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) {
                obj[fields[i]] = fields[i + 1];
            }
            let data;
            try { data = JSON.parse(obj.data); } catch (_) { data = obj.data; }
            return { id, data };
        });
    } catch (_) { return []; }
}

/**
 * XGROUP CREATE — idempotent consumer group creation with MKSTREAM.
 * @param {string} streamKey
 * @param {string} groupName
 * @param {string} startId   defaults to "0" (read from beginning)
 */
async function createConsumerGroup(streamKey, groupName, startId = '0') {
    if (!_pub || !_connected) return;
    try {
        await _pub.xgroup('CREATE', streamKey, groupName, startId, 'MKSTREAM');
    } catch (e) {
        // BUSYGROUP = group already exists — that's fine
        if (e && e.message && !e.message.includes('BUSYGROUP')) throw e;
    }
}

/**
 * XACK — acknowledge a message for a consumer group.
 * @param {string} streamKey
 * @param {string} groupName
 * @param {string} messageId
 */
async function ackMessage(streamKey, groupName, messageId) {
    if (!_pub || !_connected) return;
    try {
        await _pub.xack(streamKey, groupName, messageId);
    } catch (_) {}
}

/**
 * XREADGROUP — read new messages for a consumer in a group.
 * @param {string} streamKey
 * @param {string} groupName
 * @param {string} consumerName
 * @param {number} count
 * @returns {Array}  array of { id, data } or []
 */
async function readGroup(streamKey, groupName, consumerName, count = 100) {
    if (!_pub || !_connected) return [];
    try {
        const result = await _pub.xreadgroup(
            'GROUP', groupName, consumerName,
            'COUNT', count,
            'STREAMS', streamKey, '>'
        );
        if (!result) return [];
        const entries = result[0][1];
        return entries.map(([id, fields]) => {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) {
                obj[fields[i]] = fields[i + 1];
            }
            let data;
            try { data = JSON.parse(obj.data); } catch (_) { data = obj.data; }
            return { id, data };
        });
    } catch (_) { return []; }
}

// ── Health check ────────────────────────────────────────────────────────

function getHealth() {
    return {
        connected: _connected,
        pubReady:  _pub?.status === 'ready' || false,
        subReady:  _sub?.status === 'ready' || false,
        uptime:    _startedAt ? Date.now() - _startedAt : 0
    };
}

// ── Exported adapter object ─────────────────────────────────────────────

export const adapter = {
    name: 'redis',
    async start() { await _connect(); },
    emit(topic, payload) {
        // Publish to Redis (cross-process) AND emit locally for synchronous
        // listeners that don't want to round-trip through Redis.
        const channel = `qe:${topic}`;
        try { _pub?.publish(channel, JSON.stringify(payload || {})); } catch (_) {}
        _local.emit(topic, payload);
    },
    on(topic, handler) {
        _local.on(topic, handler);
    },
    off(topic, handler) {
        _local.off(topic, handler);
    },
    setMaxListeners(n) { _local.setMaxListeners(n); },
    async shutdown() {
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        _connected = false;
        try { await _pub?.quit(); } catch (_) {}
        try { await _sub?.quit(); } catch (_) {}
    },

    // ── Streams API (new in Omega 10) ────────────────────────────────────
    addToStream,
    readStream,
    createConsumerGroup,
    ackMessage,
    readGroup,
    getHealth
};
