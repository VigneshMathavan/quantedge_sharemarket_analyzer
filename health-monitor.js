// health-monitor.js — Background watchdog that pings the backend every 30s
// and writes a heartbeat file. If backend doesn't respond for 60s it logs
// a warning so the auto-restart wrapper can take action.
//
// Run via:  node health-monitor.js
// Or have start-quantedge.bat launch it alongside.

const HEALTH_URL = 'http://localhost:4300/api/health';
const CHECK_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 5_000;

let lastSuccess = Date.now();
let consecutiveFailures = 0;

async function check() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const r = await fetch(HEALTH_URL, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw new Error('non-200');
        const j = await r.json();
        lastSuccess = Date.now();
        if (consecutiveFailures > 0) {
            console.log(`[health] ✓ recovered after ${consecutiveFailures} failures · mode=${j.mode}`);
            consecutiveFailures = 0;
        } else {
            process.stdout.write(`[${new Date().toISOString()}] ✓ healthy · mode=${j.mode}\r`);
        }
    } catch (e) {
        clearTimeout(timer);
        consecutiveFailures++;
        const downSec = Math.round((Date.now() - lastSuccess) / 1000);
        console.error(`\n[health] ✗ FAIL #${consecutiveFailures} (down for ${downSec}s): ${e.message}`);
        if (consecutiveFailures >= 3) {
            console.error(`[health] backend has been down for ${downSec}s — check the backend window for errors`);
        }
    }
}

console.log('[health-monitor] starting · checking', HEALTH_URL, 'every', CHECK_INTERVAL_MS / 1000 + 's');
check();
setInterval(check, CHECK_INTERVAL_MS);
