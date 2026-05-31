// server/candle-cache.js — in-memory cache for provider.getHistorical()
//
// Why: multi-TF scanner needs to fetch 7 timeframes × N symbols every 2s.
// Without cache that's 7 Yahoo round-trips per request = 5-15s latency.
// With cache: first hit warms it (~3s), every subsequent request reads
// from RAM (<5ms). Background refresher keeps cache fresh.

const TTL_MS = {
    '1minute': 8_000,    // refresh every 8s
    '3minute': 15_000,
    '5minute': 20_000,
    '15minute': 45_000,
    '30minute': 60_000,
    '60minute': 120_000,
    '1day': 300_000
};

export class CandleCache {
    constructor(provider) {
        this.provider = provider;
        this.cache = new Map();     // key = `${symbol}|${tf}` → { candles, ts, inflight }
        this.subscribers = new Set(); // (symbol, tf) pairs to keep warm
    }

    key(symbol, tf) { return `${symbol}|${tf}`; }

    // Mark (symbol,tf) for background refresh — multi-tf endpoint hits this.
    subscribe(symbol, tf) {
        this.subscribers.add(this.key(symbol, tf));
    }

    // Fetch from cache or provider. Always returns within ~5ms after warmed.
    async get(symbol, tf, count = 220) {
        const k = this.key(symbol, tf);
        const ttl = TTL_MS[tf] || 30_000;
        const entry = this.cache.get(k);
        const now = Date.now();

        // Cache hit (fresh)
        if (entry && entry.candles && now - entry.ts < ttl) {
            return entry.candles.slice(-count);
        }

        // Already fetching — wait for in-flight promise (avoid stampede)
        if (entry?.inflight) {
            try { await entry.inflight; } catch (_) {}
            const fresh = this.cache.get(k);
            if (fresh?.candles) return fresh.candles.slice(-count);
        }

        // Cold or expired — fetch
        const p = this.provider.getHistorical(symbol, tf, Math.max(count, 250))
            .then(candles => {
                this.cache.set(k, { candles, ts: Date.now(), inflight: null });
                this.subscribe(symbol, tf);
                return candles;
            })
            .catch(err => {
                // Don't throw — return last good copy if we have one
                const old = this.cache.get(k);
                this.cache.set(k, { ...(old || {}), inflight: null, lastError: err.message, errTs: Date.now() });
                if (old?.candles) return old.candles;
                throw err;
            });

        this.cache.set(k, { ...(entry || {}), inflight: p });

        try {
            const candles = await p;
            return candles.slice(-count);
        } catch (e) {
            if (entry?.candles) return entry.candles.slice(-count); // serve stale on error
            throw e;
        }
    }

    // Background refresher — refresh subscribed entries before TTL expires.
    startRefresher() {
        if (this._timer) return;
        this._timer = setInterval(() => this.tick().catch(() => {}), 2000);
    }

    async tick() {
        const now = Date.now();
        const tasks = [];
        for (const k of this.subscribers) {
            const entry = this.cache.get(k);
            const [symbol, tf] = k.split('|');
            const ttl = TTL_MS[tf] || 30_000;
            const age = entry ? now - entry.ts : Infinity;
            // Refresh when ~70% of TTL elapsed, so cache is always fresh on read
            if (age > ttl * 0.7 && !entry?.inflight) {
                tasks.push(this.get(symbol, tf, 250).catch(() => {}));
            }
        }
        if (tasks.length) await Promise.all(tasks);
    }

    stats() {
        return {
            entries: this.cache.size,
            subscribers: this.subscribers.size,
            keys: Array.from(this.cache.keys())
        };
    }
}
