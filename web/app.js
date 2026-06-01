// app.js — QuantEdge Options Terminal entry point

const SETTINGS = JSON.parse(localStorage.getItem('qe2_settings') || '{}');
// Onboarding modal stores under a separate key — merge it in so we don't have
// stale values when the user changes capital via the modal.
let _capSaved = null;
try { _capSaved = JSON.parse(localStorage.getItem('qe-capital') || 'null'); } catch (_) {}

// ────────────────────────────────────────────────────────────────
// Backend URL auto-detection:
//   • Local dev (localhost / 127.0.0.1)  → http://localhost:4300
//   • Vercel / any deployed origin       → '' (use relative paths,
//     Vercel rewrites /api/* to Railway behind the scenes)
//   • WebSocket: relative paths don't work cross-origin on Vercel,
//     so deployed origin uses the SAME origin as the page (Vercel
//     proxies /ws too). Local dev hits the backend WS directly.
// ────────────────────────────────────────────────────────────────
function detectBackend() {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    return isLocal ? 'http://localhost:4300' : '';   // '' = relative
}
// ALWAYS use auto-detect — ignore any stale localStorage backend (would
// pin a deployed user to localhost). User can still override via settings.
const detectedBackend = detectBackend();

const cfg = {
    backend: detectedBackend,
    capital: (_capSaved?.capital) || SETTINGS.capital || 200000,
    risk: (_capSaved?.risk) || SETTINGS.risk || 5,
    // GOD MODE: signals fire as soon as engine sees any setup — confidence
    // is shown on every card so YOU decide. Lower threshold = more training
    // data feeding the calibrator + path forecaster.
    minAiScore: SETTINGS.minAiScore || 0,
    maxTrades: SETTINGS.maxTrades || 5
};
// Clamp legacy values
if (cfg.risk < 5) cfg.risk = 5;
if (cfg.risk > 30) cfg.risk = 30;
cfg.risk = Math.round(cfg.risk / 5) * 5;

const SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'];
const SYMBOL_NAMES = { NIFTY: 'NIFTY 50', SENSEX: 'SENSEX', FINNIFTY: 'FINNIFTY' };

const STATE = {
    selectedSymbol: 'NIFTY',
    selectedTF: '3minute',
    candles: [],
    chain: [],
    chainExpiry: null,
    activeSignal: null,
    recentSignals: [],
    logs: [],
    activeIndicators: new Set(['ema', 'vwap']),
    lastPrices: {},
    chart: null,
    candleSeries: null,
    ema9Series: null, ema21Series: null,
    vwapSeries: null, bbUpper: null, bbLower: null,
    volumeSeries: null,
    signalLines: [],
    markers: [],
    market: new MarketClient(cfg.backend),
    pnlToday: 0,
    tradesToday: 0,
    indianVIX: 13.42,
    pcr: 0.92,
    fii: -1247,
    advDec: '1248 / 952'
};

// ============================================================
//  Boot
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    setupTopbar();
    setupSidebar();
    setupChartHead();
    setupSettings();
    initChart();
    startClock();
    wireMarket();
    addLog('INFO', 'QuantEdge Options Terminal booted');
    try {
        const h = await STATE.market.health();
        setConnStatus(h.mode === 'mock' ? 'mock' : 'ok', h.mode === 'mock' ? 'Mock data' : 'Live (Breeze)');
        document.getElementById('sp-mode').textContent = h.mode === 'mock' ? 'MOCK' : 'LIVE';
        document.getElementById('sp-mode').style.background = h.mode === 'mock' ? 'var(--yellow-soft)' : 'var(--accent-soft)';
        document.getElementById('sp-mode').style.color = h.mode === 'mock' ? 'var(--yellow)' : 'var(--accent)';
        addLog('INFO', `Backend mode: ${h.mode}`);
        if (h.mode === 'mock') addLog('WARN', 'Running on mock data — see README for live setup');
    } catch (e) {
        setConnStatus('err', 'Backend offline');
        addLog('ERROR', `Backend unreachable at ${cfg.backend}`);
    }
    STATE.market.connectWS();
    STATE.market.subscribe(SYMBOLS);
    await loadHistory();
    await loadOptionChain();
    renderTickerStrip();
    renderIdleSignal();
    renderRecentSignals();
    updateSidebarAccount();

    // Bootstrap the main price IMMEDIATELY via REST so user doesn't stare at "…"
    // until the first WS tick lands.
    try {
        const q = await STATE.market.getQuote(STATE.selectedSymbol);
        if (q?.ltp) onTick({
            symbol: STATE.selectedSymbol, price: q.ltp,
            change: q.change, changePercent: q.changePercent,
            volume: q.volume, time: q.time
        });
    } catch (e) {}
});

// ============================================================
//  Topbar / sidebar wiring
// ============================================================
function setupTopbar() {
    // Settings gear removed — use the Account section in sidebar.
    // Account row + edit button both open the onboarding modal in edit mode.
    const accountEditOpener = () => {
        if (typeof showCapitalModal === 'function') showCapitalModal(true);
    };
    const editBtn = document.getElementById('acct-edit-btn');
    if (editBtn) editBtn.onclick = accountEditOpener;
    const capRow = document.getElementById('acct-capital-row');
    if (capRow) capRow.onclick = accountEditOpener;

    // Backward-compat: keep the old settings-modal hook for backend URL changes
    const oldBtn = document.getElementById('settings-btn');
    if (oldBtn) oldBtn.onclick = () => {
        document.getElementById('settings-modal').style.display = 'flex';
    };
    // Theme toggle
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.onclick = toggleTheme;
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('qe2_theme', theme);
    // Re-skin chart on theme flip
    if (STATE.chart && typeof STATE.chart.applyOptions === 'function') {
        const isLight = theme === 'light';
        STATE.chart.applyOptions({
            layout: {
                background: { type: 'solid', color: isLight ? '#FFFFFF' : '#05050C' },
                textColor: isLight ? '#6A6A88' : '#6E6E94'
            },
            grid: {
                vertLines: { color: isLight ? 'rgba(0,102,255,0.04)' : 'rgba(0,229,255,0.025)' },
                horzLines: { color: isLight ? 'rgba(0,102,255,0.04)' : 'rgba(0,229,255,0.025)' }
            },
            crosshair: {
                vertLine: { color: isLight ? 'rgba(0,102,255,0.4)' : 'rgba(0,229,255,0.4)', width: 1, style: 2, labelBackgroundColor: isLight ? '#0066FF' : '#00E5FF' },
                horzLine: { color: isLight ? 'rgba(0,102,255,0.4)' : 'rgba(0,229,255,0.4)', width: 1, style: 2, labelBackgroundColor: isLight ? '#0066FF' : '#00E5FF' }
            },
            rightPriceScale: { borderColor: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)' },
            timeScale: { borderColor: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)' }
        });
        // Repaint candles + indicators
        if (STATE.candleSeries) {
            STATE.candleSeries.applyOptions({
                upColor: isLight ? '#00A859' : '#00FF94',
                downColor: isLight ? '#D9002B' : '#FF1744',
                borderUpColor: isLight ? '#00A859' : '#00FF94',
                borderDownColor: isLight ? '#D9002B' : '#FF1744',
                wickUpColor: isLight ? '#00A859' : '#00FF94',
                wickDownColor: isLight ? '#D9002B' : '#FF1744'
            });
        }
        if (STATE.ema9Series) STATE.ema9Series.applyOptions({ color: isLight ? '#0066FF' : '#00E5FF' });
        if (STATE.ema21Series) STATE.ema21Series.applyOptions({ color: isLight ? '#C8005C' : '#FF2D7D' });
        if (STATE.vwapSeries) STATE.vwapSeries.applyOptions({ color: isLight ? '#C77700' : '#FFB300' });
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
    addLog && addLog('INFO', `Theme: ${document.documentElement.getAttribute('data-theme')}`);
}

// Apply saved theme as early as possible to prevent flash.
// Default is LIGHT — user can switch via toggle, choice persists in localStorage.
(function preloadTheme() {
    try {
        const saved = localStorage.getItem('qe2_theme');
        const initial = saved || 'light';
        document.documentElement.setAttribute('data-theme', initial);
    } catch (_) {
        document.documentElement.setAttribute('data-theme', 'light');
    }
})();

function setupSidebar() {
    document.querySelectorAll('#symbol-tabs .sym-tab').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('#symbol-tabs .sym-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            STATE.selectedSymbol = b.dataset.symbol;
            // Clear all chart overlays from the previous symbol — otherwise
            // NIFTY's S/R / OI walls / pattern markers / forecast lines
            // stay drawn on top of SENSEX's chart at NIFTY price levels.
            clearAllChartOverlays();
            loadHistory();
            loadOptionChain();
            renderMainHead();
            setTimeout(refreshBestStrikeNow, 800);   // refresh strikes for new symbol
            addLog('INFO', `Symbol: ${STATE.selectedSymbol}`);
        });
    });
    document.querySelectorAll('#tf-tabs .tf-tab').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('#tf-tabs .tf-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            STATE.selectedTF = b.dataset.tf;
            loadHistory();
            addLog('INFO', `Timeframe: ${STATE.selectedTF}`);
        });
    });
    // Risk slider with live preview — 5-30% step 5 for aggressive sizing
    const slider = document.getElementById('acct-risk-slider');
    const display = document.getElementById('acct-risk-display');
    const hidden = document.getElementById('acct-risk');
    if (slider && display) {
        // Clamp legacy values into the new 5-30 range
        if (cfg.risk < 5) cfg.risk = 5;
        if (cfg.risk > 30) cfg.risk = 30;
        slider.value = String(cfg.risk);
        display.textContent = parseFloat(cfg.risk).toFixed(0) + '%';
        hidden.value = String(cfg.risk);
        slider.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            cfg.risk = v;
            display.textContent = v.toFixed(0) + '%';
            hidden.value = String(v);
            updateSidebarAccount();
            if (STATE.activeSignal) renderSignalCard(STATE.activeSignal);
        });
        slider.addEventListener('change', () => saveSettings());
    }
}

function setupChartHead() {
    document.querySelectorAll('.ind-toggle').forEach(b => {
        b.addEventListener('click', () => {
            const ind = b.dataset.ind;
            const isOn = STATE.activeIndicators.has(ind);
            if (isOn) { STATE.activeIndicators.delete(ind); b.classList.remove('active'); }
            else { STATE.activeIndicators.add(ind); b.classList.add('active'); }
            applyIndicatorVisibility();
        });
    });
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadHistory();
        loadOptionChain();
        addLog('INFO', 'Manual refresh');
    });
}

function setupSettings() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    document.getElementById('settings-close').onclick = () => modal.style.display = 'none';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    // Always reload from the latest cfg + saved capital so we never show stale values
    function loadIntoForm() {
        document.getElementById('set-capital').value = cfg.capital;
        document.getElementById('set-risk').value = cfg.risk;
        document.getElementById('set-min-score').value = cfg.minAiScore || 70;
        document.getElementById('set-max-trades').value = cfg.maxTrades;
        document.getElementById('set-backend').value = cfg.backend;
    }
    loadIntoForm();
    // Reload form every time it opens (in case capital was changed via the
    // onboarding modal or sidebar after this was first wired).
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', loadIntoForm);

    document.getElementById('set-save').onclick = () => {
        const capEl = document.getElementById('set-capital');
        const riskEl = document.getElementById('set-risk');
        const minScoreEl = document.getElementById('set-min-score');

        // Validate capital
        const newCap = parseFloat(capEl.value);
        if (!newCap || newCap < 10000) {
            toast('Capital must be at least ₹10,000', 'error');
            capEl.focus();
            return;
        }

        // Validate + snap risk to nearest 5 within 5-30
        let newRisk = parseFloat(riskEl.value);
        if (!newRisk || newRisk < 5) newRisk = 5;
        if (newRisk > 30) newRisk = 30;
        newRisk = Math.round(newRisk / 5) * 5;
        riskEl.value = newRisk;

        // Min AI score
        let minScore = parseFloat(minScoreEl.value);
        if (!minScore || minScore < 50) minScore = 70;
        if (minScore > 95) minScore = 95;
        minScoreEl.value = minScore;

        cfg.capital = newCap;
        cfg.risk = newRisk;
        cfg.minAiScore = minScore;
        cfg.maxTrades = parseInt(document.getElementById('set-max-trades').value) || cfg.maxTrades;

        const newBackend = document.getElementById('set-backend').value.trim() || cfg.backend;
        if (newBackend !== cfg.backend) {
            cfg.backend = newBackend;
            STATE.market.setBackend(cfg.backend);
            STATE.market.connectWS();
        }

        // Persist into BOTH storage keys so onboarding modal + sidebar stay in sync
        saveSettings();
        try {
            localStorage.setItem('qe-capital', JSON.stringify({ capital: cfg.capital, risk: cfg.risk, savedAt: Date.now() }));
        } catch (e) {}

        STATE.accountSize = cfg.capital;
        STATE.riskPercent = cfg.risk;
        updateSidebarAccount();
        if (typeof syncCapitalIntoUI === 'function') syncCapitalIntoUI();
        if (typeof refreshBestStrikeNow === 'function') setTimeout(refreshBestStrikeNow, 200);

        modal.style.display = 'none';
        toast(`Settings saved · ₹${newCap.toLocaleString('en-IN')} · ${newRisk}% risk · score ≥ ${minScore}`, 'success');
    };
}

function saveSettings() {
    localStorage.setItem('qe2_settings', JSON.stringify(cfg));
}

function startClock() {
    const el = document.getElementById('clock');
    const tick = () => {
        const now = new Date();
        const t = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
        el.textContent = t + ' IST';
    };
    tick(); setInterval(tick, 1000);
}

function setConnStatus(state, label) {
    const el = document.getElementById('conn-status');
    el.classList.remove('ok', 'err', 'mock');
    el.classList.add(state);
    document.getElementById('conn-label').textContent = label;
}

// ============================================================
//  Chart
// ============================================================
function initChart() {
    if (!window.LightweightCharts) return;
    const container = document.getElementById('chart-container');
    const isLight = (document.documentElement.getAttribute('data-theme') || 'dark') === 'light';
    const themeColors = isLight ? {
        bg: '#FFFFFF', txt: '#6A6A88',
        grid: 'rgba(0,102,255,0.04)',
        cross: 'rgba(0,102,255,0.4)', crossBg: '#0066FF',
        scale: 'rgba(0,0,0,0.06)',
        up: '#00A859', down: '#D9002B',
        ema9: '#0066FF', ema21: '#C8005C', vwap: '#C77700',
        bb: 'rgba(0,102,255,0.5)', volUp: 'rgba(0,168,89,0.3)', volDn: 'rgba(217,0,43,0.3)'
    } : {
        bg: '#05050C', txt: '#6E6E94',
        grid: 'rgba(0,229,255,0.025)',
        cross: 'rgba(0,229,255,0.4)', crossBg: '#00E5FF',
        scale: 'rgba(255,255,255,0.08)',
        up: '#00FF94', down: '#FF1744',
        ema9: '#00E5FF', ema21: '#FF2D7D', vwap: '#FFB300',
        bb: 'rgba(0,229,255,0.5)', volUp: 'rgba(0,255,148,0.35)', volDn: 'rgba(255,23,68,0.35)'
    };

    // IST formatter — Yahoo timestamps are UTC seconds. NSE traders read IST.
    // Convert to "HH:mm IST" for axis ticks; "dd MMM yyyy HH:mm IST" for the crosshair label.
    const istFmt = (unixSec, withDate = false) => {
        const ms = (unixSec + 5 * 3600 + 30 * 60) * 1000;
        const d = new Date(ms);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        if (!withDate) return `${hh}:${mm}`;
        const day = String(d.getUTCDate()).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
        const yr = d.getUTCFullYear();
        return `${day} ${mon} ${yr}  ${hh}:${mm} IST`;
    };

    STATE.chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: { background: { type: 'solid', color: themeColors.bg }, textColor: themeColors.txt, fontSize: 11, fontFamily: 'JetBrains Mono' },
        grid: { vertLines: { color: themeColors.grid }, horzLines: { color: themeColors.grid } },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: themeColors.cross, width: 1, style: 2, labelBackgroundColor: themeColors.crossBg },
            horzLine: { color: themeColors.cross, width: 1, style: 2, labelBackgroundColor: themeColors.crossBg }
        },
        localization: {
            timeFormatter: (t) => istFmt(t, true)
        },
        rightPriceScale: { borderColor: themeColors.scale },
        timeScale: {
            borderColor: themeColors.scale,
            timeVisible: true,
            secondsVisible: false,
            tickMarkFormatter: (t) => istFmt(t, false)
        }
    });

    STATE.candleSeries = STATE.chart.addCandlestickSeries({
        upColor: themeColors.up, downColor: themeColors.down,
        borderUpColor: themeColors.up, borderDownColor: themeColors.down,
        wickUpColor: themeColors.up, wickDownColor: themeColors.down
    });
    STATE.volumeSeries = STATE.chart.addHistogramSeries({
        color: themeColors.volUp, priceFormat: { type: 'volume' },
        priceScaleId: '', scaleMargins: { top: 0.86, bottom: 0 }
    });
    STATE.ema9Series = STATE.chart.addLineSeries({ color: themeColors.ema9, lineWidth: 2, title: 'EMA 9' });
    STATE.ema21Series = STATE.chart.addLineSeries({ color: themeColors.ema21, lineWidth: 2, title: 'EMA 21' });
    STATE.vwapSeries = STATE.chart.addLineSeries({ color: themeColors.vwap, lineWidth: 2, lineStyle: 2, title: 'VWAP' });
    STATE.bbUpper = STATE.chart.addLineSeries({ color: themeColors.bb, lineWidth: 1, title: 'BB Upper', visible: false });
    STATE.bbLower = STATE.chart.addLineSeries({ color: themeColors.bb, lineWidth: 1, title: 'BB Lower', visible: false });

    // ============================================================
    //  AI Forecast Projection — visual representation of the
    //  Random Forest forecaster's prediction on the chart itself.
    //
    //  Three layers (all toggled by the AI Forecast switch):
    //   • Upper cone (expected MFE) — translucent green area
    //   • Lower cone (expected MAE) — translucent red area
    //   • Center drift line — solid blue/green/red showing expected direction
    //   • Horizontal price lines for T1 (spot target) and SL (spot stop)
    // ============================================================
    STATE.forecastUpperSeries = STATE.chart.addLineSeries({
        color: 'rgba(0, 208, 156, 0.55)', lineWidth: 1, lineStyle: 1,
        title: 'Forecast Upper', lastValueVisible: false, priceLineVisible: false
    });
    STATE.forecastLowerSeries = STATE.chart.addLineSeries({
        color: 'rgba(235, 91, 60, 0.55)', lineWidth: 1, lineStyle: 1,
        title: 'Forecast Lower', lastValueVisible: false, priceLineVisible: false
    });
    STATE.forecastCenterSeries = STATE.chart.addLineSeries({
        color: 'rgba(77, 125, 255, 0.85)', lineWidth: 2, lineStyle: 0,
        title: 'AI Forecast Drift', lastValueVisible: false, priceLineVisible: false
    });
    STATE.forecastConeArea = STATE.chart.addAreaSeries({
        topColor: 'rgba(0, 208, 156, 0.18)',
        bottomColor: 'rgba(235, 91, 60, 0.04)',
        lineColor: 'rgba(77, 125, 255, 0)',
        lineWidth: 0,
        lastValueVisible: false, priceLineVisible: false
    });
    STATE.forecastTargetLines = [];  // price lines for T1/SL

    // ────────────────────────────────────────────────────────────────
    // Wipes EVERY non-candle artifact off the chart:
    //   • signal price lines (entry/SL/TP)
    //   • S/R + OI wall overlay lines
    //   • forecast target/stop horizontal lines
    //   • forecast cone series (upper/lower/center/area)
    //   • pattern markers
    // Called when the user switches symbol so we don't see NIFTY's
    // price labels lingering on SENSEX's chart.
    // ────────────────────────────────────────────────────────────────
    window.clearAllChartOverlays = function() {
        if (!STATE.candleSeries) return;
        const lineGroups = [STATE.signalLines, STATE.overlayLines, STATE.forecastTargetLines];
        for (const grp of lineGroups) {
            if (!grp) continue;
            for (const l of grp) {
                try { STATE.candleSeries.removePriceLine(l); } catch (_) {}
            }
            grp.length = 0;
        }
        // Clear the projection cone series
        STATE.forecastUpperSeries?.setData([]);
        STATE.forecastLowerSeries?.setData([]);
        STATE.forecastCenterSeries?.setData([]);
        STATE.forecastConeArea?.setData([]);
        // Clear ALL markers (entry/exit + pattern arrows)
        STATE.markers = [];
        try { STATE.candleSeries.setMarkers([]); } catch (_) {}
    };

    new ResizeObserver(() => {
        STATE.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }).observe(container);
}

function applyIndicatorVisibility() {
    STATE.ema9Series?.applyOptions({ visible: STATE.activeIndicators.has('ema') });
    STATE.ema21Series?.applyOptions({ visible: STATE.activeIndicators.has('ema') });
    STATE.vwapSeries?.applyOptions({ visible: STATE.activeIndicators.has('vwap') });
    STATE.bbUpper?.applyOptions({ visible: STATE.activeIndicators.has('bb') });
    STATE.bbLower?.applyOptions({ visible: STATE.activeIndicators.has('bb') });
}

// ============================================================
//  Indicator math (frontend duplicate of server for chart overlays)
// ============================================================
function ema(arr, p) {
    if (arr.length < p) return [];
    const k = 2 / (p + 1); let s = 0;
    for (let i = 0; i < p; i++) s += arr[i];
    let e = s / p; const out = [{ idx: p - 1, v: e }];
    for (let i = p; i < arr.length; i++) {
        e = arr[i] * k + e * (1 - k);
        out.push({ idx: i, v: e });
    }
    return out;
}
function bb(closes, p = 20, sd = 2) {
    const out = [];
    for (let i = p - 1; i < closes.length; i++) {
        let s = 0;
        for (let j = i - p + 1; j <= i; j++) s += closes[j];
        const m = s / p;
        let v = 0;
        for (let j = i - p + 1; j <= i; j++) v += Math.pow(closes[j] - m, 2);
        const st = Math.sqrt(v / p);
        out.push({ idx: i, upper: m + sd * st, lower: m - sd * st });
    }
    return out;
}
function vwap(candles) {
    const out = []; let cumPV = 0, cumV = 0, lastDay = null;
    for (const c of candles) {
        const d = new Date(c.time * 1000);
        const day = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        if (day !== lastDay) { cumPV = 0; cumV = 0; lastDay = day; }
        const tp = (c.high + c.low + c.close) / 3;
        cumPV += tp * c.volume; cumV += c.volume;
        out.push(cumV === 0 ? c.close : cumPV / cumV);
    }
    return out;
}

function updateChartIndicators() {
    if (!STATE.candles.length || !STATE.ema9Series) return;
    const closes = STATE.candles.map(c => c.close);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const vw = vwap(STATE.candles);
    STATE.ema9Series.setData(e9.map(x => ({ time: STATE.candles[x.idx].time, value: x.v })));
    STATE.ema21Series.setData(e21.map(x => ({ time: STATE.candles[x.idx].time, value: x.v })));
    STATE.vwapSeries.setData(STATE.candles.map((c, i) => ({ time: c.time, value: vw[i] })));
    const b = bb(closes);
    STATE.bbUpper.setData(b.map(x => ({ time: STATE.candles[x.idx].time, value: x.upper })));
    STATE.bbLower.setData(b.map(x => ({ time: STATE.candles[x.idx].time, value: x.lower })));
}

// ============================================================
//  Data loading
// ============================================================
async function loadHistory() {
    try {
        addLog('INFO', `Loading ${STATE.selectedSymbol} ${STATE.selectedTF}`);
        const candles = await STATE.market.getHistorical(STATE.selectedSymbol, STATE.selectedTF, 200);
        STATE.candles = candles;
        if (STATE.candleSeries) {
            STATE.candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
            STATE.volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(0,208,156,0.4)' : 'rgba(235,91,60,0.4)' })));
            updateChartIndicators();
            STATE.chart.timeScale().fitContent();
        }
        renderMainHead();
        triggerSignalCheck();
        // Log the most-recent candle so we can sanity-check freshness in the UI log
        if (candles.length) {
            const last = candles[candles.length - 1];
            const istMs = (last.time + 5.5*3600) * 1000;
            const d = new Date(istMs);
            const ts = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
            const ageMin = Math.round((Date.now()/1000 - last.time) / 60);
            addLog('INFO', `Latest candle: ${ts} IST · ₹${last.close.toFixed(2)} · ${ageMin}m old`);
        }
    } catch (e) {
        addLog('ERROR', `History load failed: ${e.message}`);
    }
}

async function loadOptionChain() {
    try {
        const chain = await STATE.market.getOptionChain(STATE.selectedSymbol);
        STATE.chain = chain;
        STATE.chainFetchedAt = Date.now();
        // pick nearest expiry (only on first load or symbol switch)
        if (!STATE.chainExpiry || !chain.some(c => c.expiry === STATE.chainExpiry)) {
            const expiries = [...new Set(chain.map(c => c.expiry).filter(Boolean))].sort();
            STATE.chainExpiry = expiries[0] || null;
            renderChainExpiry(expiries);
        }
        renderOptionChain();
        // Show freshness label in chain header so user can see how stale
        const metaEl = document.getElementById('chain-meta');
        if (metaEl && !metaEl.dataset.tsBound) {
            metaEl.dataset.tsBound = '1';
            setInterval(() => {
                const el = document.getElementById('chain-meta');
                if (!el || !STATE.chainFetchedAt) return;
                const sec = Math.round((Date.now() - STATE.chainFetchedAt) / 1000);
                const freshness = sec < 6 ? `🟢 ${sec}s` : sec < 30 ? `🟡 ${sec}s` : `🔴 ${sec}s`;
                const txt = el.textContent.replace(/\s*·\s*\d+s.*$/, '');
                el.textContent = `${txt} · ${freshness}`;
            }, 1000);
        }
    } catch (e) {
        addLog('ERROR', `Chain load failed: ${e.message}`);
    }
}

// ────────────────────────────────────────────────────────────────
// Auto-refresh option chain every 5s during market hours (9:15-15:30 IST).
// Outside that window we refresh every 60s to save API calls.
// ────────────────────────────────────────────────────────────────
function isMarketHours() {
    const now = new Date();
    const utc = now.getTime() + (5 * 60 + 30) * 60000;
    const ist = new Date(utc);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;            // weekend
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}
let _chainTickTimer = null;
function scheduleChainRefresh() {
    if (_chainTickTimer) clearInterval(_chainTickTimer);
    _chainTickTimer = setInterval(() => {
        if (!STATE.selectedSymbol) return;
        loadOptionChain();
    }, isMarketHours() ? 5000 : 60000);
}
setTimeout(() => {
    scheduleChainRefresh();
    // Re-evaluate market-hours every minute (handles open/close transition)
    setInterval(scheduleChainRefresh, 60000);
}, 4000);

function renderChainExpiry(expiries) {
    const sel = document.getElementById('chain-expiry');
    if (!sel) return;
    if (expiries.length === 0) {
        sel.innerHTML = '<option>—</option>'; return;
    }
    sel.innerHTML = expiries.map(e => `<option value="${e}">${e}</option>`).join('');
    sel.value = STATE.chainExpiry;
    sel.onchange = () => { STATE.chainExpiry = sel.value; renderOptionChain(); };
}

// ============================================================
//  Live ticks
// ============================================================
function wireMarket() {
    STATE.market.on('open', () => setConnStatus(STATE.market.mode === 'mock' ? 'mock' : 'ok', STATE.market.mode === 'mock' ? 'Mock data' : 'Live'));
    STATE.market.on('close', () => setConnStatus('err', 'Reconnecting...'));
    STATE.market.on('hello', (msg) => { STATE.market.mode = msg.mode; });
    STATE.market.on('tick', onTick);
}

function onTick(tick) {
    const prev = STATE.lastPrices[tick.symbol];
    STATE.lastPrices[tick.symbol] = tick;
    // ticker strip
    const el = document.querySelector(`#ticker-strip .tk[data-sym="${tick.symbol}"]`);
    if (el) {
        const priceEl = el.querySelector('.tk-price');
        const chgEl = el.querySelector('.tk-chg');
        priceEl.textContent = fmtPrice(tick.price);
        chgEl.textContent = fmtPct(tick.changePercent);
        chgEl.className = 'tk-chg ' + (tick.change >= 0 ? 'up' : 'dn');
        if (prev) {
            priceEl.classList.remove('flash-up', 'flash-dn');
            void priceEl.offsetWidth;
            priceEl.classList.add(tick.price >= prev.price ? 'flash-up' : 'flash-dn');
        }
    }

    if (tick.symbol === STATE.selectedSymbol) {
        const mp = document.getElementById('main-price');
        mp.textContent = fmtPrice(tick.price);
        mp.classList.remove('loading-shimmer');
        const ch = document.getElementById('main-change');
        ch.textContent = fmtPct(tick.changePercent);
        ch.className = 'main-change ' + (tick.change >= 0 ? 'up' : 'dn');
        ch.classList.remove('loading-shimmer');

        // ────────────────────────────────────────────────────────────
        //  Live candle update — closes the gap between chart and broker.
        //  Detects when the tick's time falls into a NEW candle bucket
        //  and APPENDS a new candle. Otherwise mutates the current one
        //  (low/high/close) so the bar visibly grows in real time.
        // ────────────────────────────────────────────────────────────
        if (STATE.candles.length && STATE.candleSeries) {
            const tfSecMap = { '1minute':60,'3minute':180,'5minute':300,'15minute':900,'30minute':1800,'60minute':3600,'1day':24*60*60 };
            const tfSec = tfSecMap[STATE.selectedTF] || 300;
            const nowSec = Math.floor(Date.now() / 1000);
            const bucket = Math.floor(nowSec / tfSec) * tfSec;
            const last = STATE.candles[STATE.candles.length - 1];
            if (bucket === last.time) {
                // same bucket → mutate
                last.close = tick.price;
                if (tick.price > last.high) last.high = tick.price;
                if (tick.price < last.low) last.low = tick.price;
                STATE.candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
            } else if (bucket > last.time) {
                // candle boundary crossed → forge a new candle from this tick
                const fresh = { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: 0 };
                STATE.candles.push(fresh);
                STATE.candleSeries.update(fresh);
            }
            // bucket < last.time (stale tick) → ignore
        }
    }
}

// Periodic candle refresh — every 4s for true near-real-time anchoring.
// Server cache makes this ~5ms response so it doesn't load the network.
setInterval(async () => {
    if (!STATE.candles.length) return;
    try {
        const candles = await STATE.market.getHistorical(STATE.selectedSymbol, STATE.selectedTF, 200);
        if (candles.length && candles[candles.length - 1].time !== STATE.candles[STATE.candles.length - 1].time) {
            STATE.candles = candles;
            STATE.candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
            STATE.volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(0,208,156,0.4)' : 'rgba(235,91,60,0.4)' })));
            updateChartIndicators();
        }
    } catch (e) {}
}, 4000);   // 4s — keeps chart fresh while live ticks fill the gap between

// Trigger signal check every 2s — God Mode: fire fast, train hard.
setInterval(triggerSignalCheck, 2000);

async function triggerSignalCheck() {
    if (STATE.candles.length < 30) return;
    const currentPrice = STATE.lastPrices[STATE.selectedSymbol]?.price || STATE.candles[STATE.candles.length - 1].close;
    try {
        const signal = await STATE.market.evaluateSignal({
            symbol: STATE.selectedSymbol,
            candles: STATE.candles,
            currentPrice,
            chain: STATE.chain,
            accountSize: cfg.capital,
            riskPercent: cfg.risk
        });
        if (signal.side === 'NO_TRADE') {
            // keep idle card if no active signal already
            if (!STATE.activeSignal) renderIdleSignal(signal.reason);
            return;
        }
        // only fire if confidence high enough OR no current signal
        const last = STATE.activeSignal;
        if (last && last.id === signal.id) return;
        if (!last || signal.confidence > last.confidence) {
            applyNewSignal(signal);
        }
    } catch (e) {
        addLog('ERROR', 'Signal eval failed: ' + e.message);
    }
}

function applyNewSignal(signal) {
    STATE.activeSignal = signal;
    STATE.recentSignals.unshift(signal);
    if (STATE.recentSignals.length > 15) STATE.recentSignals.pop();
    addLog('SIGNAL', `${signal.side === 'BUY_CALL' ? '🟢 BUY CALL' : '🔴 BUY PUT'} ${signal.option.strike} ${signal.option.right} @ ₹${signal.option.premium} — Conf ${signal.confidence}% ${signal.tier}`);
    renderSignalCard(signal);
    renderRecentSignals();
    drawChartLevels(signal);
    showChartPopup(signal);
    renderOptionChain(); // highlight the picked strike
    toast(`${signal.side === 'BUY_CALL' ? 'BUY CALL' : 'BUY PUT'} ${signal.option.strike} @ ₹${signal.option.premium}`, 'success');
}

function drawChartLevels(signal) {
    if (!STATE.candleSeries) return;
    STATE.signalLines.forEach(l => { try { STATE.candleSeries.removePriceLine(l); } catch (_) {} });
    STATE.signalLines = [];
    const isCall = signal.side === 'BUY_CALL';
    STATE.signalLines.push(STATE.candleSeries.createPriceLine({
        price: signal.spot.entry, color: isCall ? '#00D09C' : '#EB5B3C', lineWidth: 2, lineStyle: 0, title: 'Entry'
    }));
    STATE.signalLines.push(STATE.candleSeries.createPriceLine({
        price: signal.spot.stopLoss, color: '#EB5B3C', lineWidth: 1, lineStyle: 2, title: 'SL'
    }));
    STATE.signalLines.push(STATE.candleSeries.createPriceLine({
        price: signal.spot.target1, color: '#00D09C', lineWidth: 1, lineStyle: 2, title: 'T1'
    }));
    STATE.signalLines.push(STATE.candleSeries.createPriceLine({
        price: signal.spot.target2, color: '#00D09C', lineWidth: 1, lineStyle: 2, title: 'T2'
    }));
    STATE.markers.push({
        time: STATE.candles[STATE.candles.length - 1].time,
        position: isCall ? 'belowBar' : 'aboveBar',
        color: isCall ? '#00D09C' : '#EB5B3C',
        shape: isCall ? 'arrowUp' : 'arrowDown',
        text: isCall ? 'BUY CE' : 'BUY PE',
        size: 2
    });
    if (STATE.markers.length > 20) STATE.markers.shift();
    STATE.candleSeries.setMarkers(STATE.markers);
}

function showChartPopup(signal) {
    const wrap = document.getElementById('chart-overlay-popups');
    const isCall = signal.side === 'BUY_CALL';
    const popup = document.createElement('div');
    popup.className = 'chart-popup' + (isCall ? '' : ' put');
    popup.innerHTML = `
        <div class="cp-head">
            <span class="cp-badge">${isCall ? 'BUY CALL' : 'BUY PUT'} ${signal.option.strike}</span>
            <span class="cp-conf">${signal.confidence}%</span>
        </div>
        <div class="cp-body">
            <div class="cp-row"><span>Premium</span><b>₹${signal.option.premium}</b></div>
            <div class="cp-row"><span>SL</span><b style="color:var(--red)">₹${signal.option.premiumSL}</b></div>
            <div class="cp-row"><span>T1</span><b style="color:var(--accent)">₹${signal.option.premiumT1}</b></div>
            <div class="cp-row"><span>Lots</span><b>${signal.sizing.lots}</b></div>
        </div>`;
    wrap.appendChild(popup);
    setTimeout(() => popup.style.opacity = '0', 12000);
    setTimeout(() => popup.remove(), 13000);
}

// ============================================================
//  Render: ticker, head, chain, signal card
// ============================================================
function renderTickerStrip() {
    const strip = document.getElementById('ticker-strip');
    strip.innerHTML = SYMBOLS.map(s => `
        <div class="tk" data-sym="${s}">
            <span class="tk-label">${SYMBOL_NAMES[s].replace(' 50','')}</span>
            <span class="tk-price">--</span>
            <span class="tk-chg up">--</span>
        </div>
    `).join('');
}

function renderMainHead() {
    document.getElementById('main-symbol').textContent = SYMBOL_NAMES[STATE.selectedSymbol];
    const lastTick = STATE.lastPrices[STATE.selectedSymbol];
    if (lastTick) {
        document.getElementById('main-price').textContent = fmtPrice(lastTick.price);
        const ch = document.getElementById('main-change');
        ch.textContent = fmtPct(lastTick.changePercent);
        ch.className = 'main-change ' + (lastTick.change >= 0 ? 'up' : 'dn');
    }
}

function renderOptionChain() {
    const body = document.getElementById('chain-body');
    const meta = document.getElementById('chain-meta');
    if (!body) return;
    if (STATE.chain.length === 0) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--text-3)">Loading option chain...</td></tr>';
        return;
    }
    const filtered = STATE.chainExpiry ? STATE.chain.filter(o => o.expiry === STATE.chainExpiry) : STATE.chain;
    const strikes = [...new Set(filtered.map(o => o.strike))].sort((a, b) => a - b);
    const spot = STATE.lastPrices[STATE.selectedSymbol]?.price || STATE.candles[STATE.candles.length - 1]?.close || strikes[Math.floor(strikes.length / 2)];
    const atmStrike = strikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, strikes[0]);
    const atmIdx = strikes.indexOf(atmStrike);
    const window = strikes.slice(Math.max(0, atmIdx - 6), Math.min(strikes.length, atmIdx + 7));
    const maxOI = Math.max(...filtered.map(o => o.oi));
    const ceTotal = filtered.filter(o => o.type === 'CE').reduce((x, y) => x + y.oi, 0);
    const peTotal = filtered.filter(o => o.type === 'PE').reduce((x, y) => x + y.oi, 0);
    const pcr = ceTotal === 0 ? 1 : peTotal / ceTotal;
    meta.textContent = `PCR: ${pcr.toFixed(2)} • Spot: ${fmtPrice(spot)} • ATM: ${atmStrike}`;

    body.innerHTML = window.map(strike => {
        const ce = filtered.find(o => o.strike === strike && o.type === 'CE') || {};
        const pe = filtered.find(o => o.strike === strike && o.type === 'PE') || {};
        const isATM = strike === atmStrike;
        const isITMCE = strike < atmStrike;
        const isITMPE = strike > atmStrike;
        const isSig = STATE.activeSignal && STATE.activeSignal.option.strike === strike;
        const cls = ['chain-row',
            isATM ? 'atm' : '',
            isITMCE ? 'itm-ce' : '',
            isITMPE ? 'itm-pe' : '',
            isSig ? 'signal' : ''
        ].filter(Boolean).join(' ');
        const cePct = ce.oi ? (ce.oi / maxOI) * 80 : 0;
        const pePct = pe.oi ? (pe.oi / maxOI) * 80 : 0;
        return `<tr class="${cls}">
            <td class="${ce.oiChange > 0 ? 'oi-chg-up' : ce.oiChange < 0 ? 'oi-chg-dn' : ''}">${ce.oiChange ? (ce.oiChange > 0 ? '+' : '') + fmtVol(ce.oiChange) : '--'}</td>
            <td>${ce.oi ? fmtVol(ce.oi) : '--'} <span class="oi-bar" style="width:${cePct}px"></span></td>
            <td>${ce.iv ? ce.iv.toFixed(1) : '--'}</td>
            <td style="color:var(--text-1); font-weight:600">${ce.ltp ? ce.ltp.toFixed(2) : '--'}</td>
            <td class="strike">${strike}</td>
            <td style="color:var(--text-1); font-weight:600">${pe.ltp ? pe.ltp.toFixed(2) : '--'}</td>
            <td>${pe.iv ? pe.iv.toFixed(1) : '--'}</td>
            <td><span class="oi-bar pe" style="width:${pePct}px"></span> ${pe.oi ? fmtVol(pe.oi) : '--'}</td>
            <td class="${pe.oiChange > 0 ? 'oi-chg-up' : pe.oiChange < 0 ? 'oi-chg-dn' : ''}">${pe.oiChange ? (pe.oiChange > 0 ? '+' : '') + fmtVol(pe.oiChange) : '--'}</td>
        </tr>`;
    }).join('');
}

function renderIdleSignal(reason) {
    const wrap = document.getElementById('signal-card-wrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <div class="signal-card-idle">
            <span class="icon">⚪</span>
            <div><b>No active signal</b></div>
            <div style="font-size: 11px; line-height: 1.4;">${reason || 'Engine scanning every 15 seconds. We only fire on multi-factor confluence.'}</div>
        </div>
    `;
    document.getElementById('trade-checklist').innerHTML = '<div style="color:var(--text-3); font-size:11px; padding:8px;">Checklist appears when a signal fires.</div>';
}

function renderSignalCard(signal) {
    const wrap = document.getElementById('signal-card-wrap');
    const isCall = signal.side === 'BUY_CALL';
    wrap.innerHTML = `
        <div class="signal-card ${isCall ? '' : 'put'}">
            <div class="sc-head">
                <span class="sc-badge">${isCall ? 'BUY CALL' : 'BUY PUT'}</span>
                <span class="sc-tier ${signal.tier}">${signal.tier} · ${signal.confidence}%</span>
            </div>
            <div class="sc-strike-block">
                <div>
                    <div class="sc-strike">${signal.option.strike}<span class="right">${signal.option.right}</span></div>
                    <div style="font-size:11px; color:var(--text-3); margin-top:2px;">@ ₹${signal.option.premium} • IV ${signal.option.iv.toFixed(1)}% (${signal.option.ivLabel})</div>
                </div>
                <span class="sc-conf-pill">Δ ${signal.option.deltaAssumed.toFixed(2)}</span>
                <div class="sc-rationale">${signal.option.rationale}</div>
            </div>
            <div class="sc-levels">
                <div class="sc-level">
                    <span class="sc-level-label">SL Premium</span>
                    <span class="sc-level-value red">₹${signal.option.premiumSL}</span>
                    <span class="sc-level-sub">Spot SL ${fmtPrice(signal.spot.stopLoss)}</span>
                </div>
                <div class="sc-level">
                    <span class="sc-level-label">Target 1</span>
                    <span class="sc-level-value green">₹${signal.option.premiumT1}</span>
                    <span class="sc-level-sub">Spot ${fmtPrice(signal.spot.target1)}</span>
                </div>
                <div class="sc-level">
                    <span class="sc-level-label">Target 2</span>
                    <span class="sc-level-value green">₹${signal.option.premiumT2}</span>
                    <span class="sc-level-sub">Spot ${fmtPrice(signal.spot.target2)}</span>
                </div>
                <div class="sc-level">
                    <span class="sc-level-label">Risk : Reward</span>
                    <span class="sc-level-value">1 : ${signal.riskReward.premium}</span>
                    <span class="sc-level-sub">Time stop ${new Date(signal.timeStop).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
            </div>
            <div class="sc-sizing">
                <div class="sc-sizing-row"><span>Lots</span><b>${signal.sizing.lots}</b></div>
                <div class="sc-sizing-row"><span>Quantity</span><b>${signal.sizing.quantity}</b></div>
                <div class="sc-sizing-row"><span>Capital</span><b>${fmtCurrency(signal.sizing.capitalRequired)}</b></div>
                <div class="sc-sizing-row"><span>Max Loss</span><b style="color:var(--red)">${fmtCurrency(signal.sizing.maxLoss)}</b></div>
                <div class="sc-sizing-row" style="grid-column:1/-1; border-top:1px solid var(--border); padding-top:6px;">
                    <span>Risk on Account</span><b>${signal.sizing.riskPercent}% (target ${signal.sizing.riskTarget}%)</b>
                </div>
            </div>
            <div class="sc-reasoning">
                ${signal.reasoning.map(r => {
                    const ok = r.startsWith('✓');
                    return `<div class="sc-reason-row"><span class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</span><span class="txt">${r.slice(2)}</span></div>`;
                }).join('')}
            </div>
        </div>
    `;
    // Trade checklist
    const cl = document.getElementById('trade-checklist');
    cl.innerHTML = signal.tradeChecklist.map((step, i) => {
        const warn = step.startsWith('⚠');
        return `<div class="checklist-item ${warn ? 'warn' : ''}">
            <span class="num">${warn ? '!' : i + 1}</span>
            <span class="txt">${step}</span>
        </div>`;
    }).join('');
}

function renderRecentSignals() {
    const el = document.getElementById('recent-signals');
    if (!el) return;
    if (STATE.recentSignals.length === 0) {
        el.innerHTML = '<div style="color:var(--text-3); font-size:11px; padding:8px;">No signals yet.</div>';
        return;
    }
    el.innerHTML = STATE.recentSignals.slice(0, 8).map(s => {
        const t = new Date(s.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        return `<div class="recent-item">
            <div class="recent-meta">
                <span class="recent-strike ${s.side === 'BUY_CALL' ? 'call' : 'put'}">${s.option.strike} ${s.option.right}</span>
                <span class="recent-time">${t} • ₹${s.option.premium}</span>
            </div>
            <span class="recent-conf ${s.tier}">${s.confidence}%</span>
        </div>`;
    }).join('');
}

function updateSidebarAccount() {
    document.getElementById('acct-capital').textContent = fmtCurrency(cfg.capital);
    const hidden = document.getElementById('acct-risk');
    if (hidden) hidden.value = String(cfg.risk);
    // Risk slider already snaps to step 5
    const disp = document.getElementById('acct-risk-display');
    if (disp) disp.textContent = parseFloat(cfg.risk).toFixed(0) + '%';
    const maxLossEl = document.getElementById('acct-max-loss');
    if (maxLossEl) maxLossEl.textContent = fmtCurrency(cfg.capital * cfg.risk / 100);
    document.getElementById('acct-pnl').textContent = fmtCurrency(STATE.pnlToday);
    document.getElementById('acct-pnl').style.color = STATE.pnlToday >= 0 ? 'var(--accent)' : 'var(--red)';
    document.getElementById('acct-trades-left').textContent = `${Math.max(0, cfg.maxTrades - STATE.tradesToday)} / ${cfg.maxTrades}`;
    // sidebar pulse
    document.getElementById('pulse-vix').textContent = STATE.indianVIX.toFixed(2);
    document.getElementById('pulse-pcr').textContent = STATE.pcr.toFixed(2);
    document.getElementById('pulse-advdec').textContent = STATE.advDec;
    document.getElementById('pulse-fii').textContent = `₹${STATE.fii} Cr`;
    document.getElementById('pulse-fii').style.color = STATE.fii >= 0 ? 'var(--accent)' : 'var(--red)';
}

setInterval(() => {
    STATE.indianVIX = Math.max(8, STATE.indianVIX + (Math.random() - 0.5) * 0.1);
    STATE.pcr = Math.max(0.4, STATE.pcr + (Math.random() - 0.5) * 0.01);
    updateSidebarAccount();
}, 5000);

// ============================================================
//  Top Movers (Discovery)
// ============================================================
async function refreshTopMovers() {
    const el = document.getElementById('top-movers');
    if (!el) return;
    try {
        const r = await fetch(STATE.market.backend + '/api/discovery/movers');
        if (!r.ok) throw new Error('fetch failed');
        const data = await r.json();
        if (!data.supported) {
            el.innerHTML = `<div class="movers-empty">Not available on ${STATE.market.mode} provider</div>`;
            return;
        }
        const list = (data.nseMostActive || []).slice(0, 8);
        if (list.length === 0) {
            el.innerHTML = `<div class="movers-empty">No movers data</div>`;
            return;
        }
        el.innerHTML = list.map(m => {
            const ticker = (m.ticker || '').replace(/\.NS$|\.BO$/, '');
            const up = m.changePercent >= 0;
            return `<div class="mover-row" title="${m.company || ticker}">
                <span class="mover-ticker">${ticker}</span>
                <span class="mover-price">${fmtPrice(m.price)}</span>
                <span class="mover-chg ${up ? 'up' : 'dn'}">${up ? '+' : ''}${m.changePercent.toFixed(2)}%</span>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = `<div class="movers-empty">Error loading: ${e.message}</div>`;
    }
}

// Initial fetch + refresh every 60 seconds
setTimeout(refreshTopMovers, 1500);
setInterval(refreshTopMovers, 60000);

// ============================================================
//  News Pulse
// ============================================================
async function refreshNews() {
    const listEl = document.getElementById('news-list');
    const chip = document.getElementById('news-sentiment');
    if (!listEl) return;
    try {
        const r = await fetch(STATE.market.backend + '/api/news/pulse');
        if (!r.ok) throw new Error('fetch failed');
        const data = await r.json();
        // Sentiment chip
        if (chip && data.marketSentiment) {
            const s = data.marketSentiment.sentiment;
            chip.textContent = s + (data.marketSentiment.score ? ` ${data.marketSentiment.score > 0 ? '+' : ''}${data.marketSentiment.score}` : '');
            chip.className = 'news-sentiment-chip ' + s;
        }
        const items = (data.items || []).slice(0, 8);
        if (items.length === 0) {
            listEl.innerHTML = '<div class="news-empty">No headlines yet.</div>';
            return;
        }
        listEl.innerHTML = items.map(it => {
            const ago = it.pubDate ? minutesAgo(it.pubDate) : '';
            return `<a class="news-item" href="${it.link || '#'}" target="_blank" rel="noopener noreferrer" title="${it.title.replace(/"/g, '&quot;')}">
                <span class="news-tag ${it.sentiment}"></span>
                <div class="news-body">
                    <div class="news-title">${it.title}</div>
                    <div class="news-meta">
                        ${it.impact ? '<span class="impact">⚡ HIGH</span>' : ''}
                        <span>${it.source}</span>
                        ${ago ? `<span>· ${ago}</span>` : ''}
                    </div>
                </div>
            </a>`;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="news-empty">Error: ${e.message}</div>`;
    }
}

function minutesAgo(pubDateStr) {
    const t = Date.parse(pubDateStr);
    if (!t) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

setTimeout(refreshNews, 2000);
setInterval(refreshNews, 5 * 60 * 1000);  // every 5 min

// ============================================================
//  Event Countdown (topbar pill)
// ============================================================
async function refreshEvents() {
    const pill = document.getElementById('event-pill');
    const text = document.getElementById('event-text');
    if (!pill || !text) return;
    try {
        const r = await fetch(STATE.market.backend + '/api/event-gate');
        if (!r.ok) throw new Error('fetch failed');
        const data = await r.json();
        pill.classList.remove('imminent', 'blocked');
        if (data.gate?.blocked) {
            pill.classList.add('blocked');
            const lbl = data.gate.label || 'Event';
            text.textContent = `BLOCK · ${lbl}`;
            pill.title = data.gate.reason;
            return;
        }
        if (!data.next) {
            text.textContent = 'No major events';
            pill.title = '';
            return;
        }
        const mins = data.next.minsAway;
        let label;
        if (mins < 60) label = `${mins}m`;
        else if (mins < 24 * 60) label = `${(mins / 60).toFixed(1)}h`;
        else label = `${Math.floor(mins / 1440)}d`;
        text.textContent = `${label} · ${data.next.label}`;
        pill.title = `${data.next.label} (${data.next.severity}) in ${label}`;
        if (mins < 180) pill.classList.add('imminent');
    } catch (e) {
        text.textContent = '—';
    }
}

setTimeout(refreshEvents, 1000);
setInterval(refreshEvents, 30 * 1000);  // every 30s

// ============================================================
//  Upstox token health — pill in topbar, click to refresh
// ============================================================
window.refreshUpstoxToken = function() {
    // Open in same tab — Upstox OAuth requires the redirect to land here
    window.location.href = '/api/auth/upstox/login';
};

async function refreshUpstoxStatus() {
    const pill = document.getElementById('upstox-pill');
    const label = document.getElementById('upstox-status');
    if (!pill || !label) return;
    try {
        const r = await fetch('/api/auth/upstox/status');
        const d = await r.json();
        pill.classList.remove('ok', 'warn', 'bad');
        if (!d.valid) {
            pill.classList.add('bad');
            label.textContent = 'UP · TOKEN EXPIRED · click to refresh';
            return;
        }
        const ext = d.extended;
        const acc = d.access;
        let badge = '';
        // Extended (annual) takes priority for status — if it's valid, data flows
        if (ext?.valid) {
            const days = Math.floor(ext.expiresInMin / 60 / 24);
            badge = `EXT · ${days}d left`;
            pill.classList.add('ok');
        } else if (acc?.valid) {
            const hrs = Math.floor(acc.expiresInMin / 60);
            badge = `DAILY · ${hrs}h left`;
            if (acc.expiresInMin < 30) pill.classList.add('warn');
            else pill.classList.add('ok');
        }
        // Add daily-token chip if we have both
        if (ext?.valid && acc?.valid) {
            const hrs = Math.floor(acc.expiresInMin / 60);
            badge += ` + DAILY ${hrs}h`;
        } else if (ext?.valid && !acc?.valid) {
            badge += ` (orders disabled)`;
            pill.classList.remove('ok');
            pill.classList.add('warn');
        }
        label.textContent = `UP · ${d.user || ''} · ${badge}`;
    } catch (e) {
        pill.classList.add('bad');
        label.textContent = 'UP · backend down';
    }
}
setTimeout(refreshUpstoxStatus, 800);
setInterval(refreshUpstoxStatus, 60 * 1000);  // every minute

// ============================================================
//  Indicator toggle switches — user can show/hide any indicator
//  Persisted to localStorage
// ============================================================
const IND_DEFAULTS = {
    ema20: true, ema50: true, vwap: true, supertrend: false,
    bollinger: false, rsi: false, atr: false,
    cpr: true, sr: true, oiwalls: true, patterns: true, forecast: true
};
function loadIndicators() {
    try {
        const saved = JSON.parse(localStorage.getItem('qe-indicators') || '{}');
        return { ...IND_DEFAULTS, ...saved };
    } catch (e) { return { ...IND_DEFAULTS }; }
}
function saveIndicators(state) {
    try { localStorage.setItem('qe-indicators', JSON.stringify(state)); } catch (e) {}
}
STATE.indicators = loadIndicators();
function applyIndicatorState() {
    document.querySelectorAll('#indicator-grid input[type=checkbox]').forEach(cb => {
        const key = cb.dataset.ind;
        cb.checked = !!STATE.indicators[key];
        const chip = cb.closest('.ind-chip');
        if (chip) chip.classList.toggle('on', cb.checked);
    });
    document.body.classList.toggle('hide-forecast', !STATE.indicators.forecast);
    document.body.classList.toggle('hide-patterns', !STATE.indicators.patterns);
    document.body.classList.toggle('hide-cpr', !STATE.indicators.cpr);

    // Show/hide individual chart series based on toggles
    STATE.ema9Series?.applyOptions({ visible: STATE.indicators.ema20 });
    STATE.ema21Series?.applyOptions({ visible: STATE.indicators.ema50 });
    STATE.vwapSeries?.applyOptions({ visible: STATE.indicators.vwap });
    STATE.bbUpper?.applyOptions({ visible: STATE.indicators.bollinger });
    STATE.bbLower?.applyOptions({ visible: STATE.indicators.bollinger });

    // Forecast projection lines/area visibility
    const fcVis = STATE.indicators.forecast;
    STATE.forecastUpperSeries?.applyOptions({ visible: fcVis });
    STATE.forecastLowerSeries?.applyOptions({ visible: fcVis });
    STATE.forecastCenterSeries?.applyOptions({ visible: fcVis });
    STATE.forecastConeArea?.applyOptions({ visible: fcVis });
    if (!fcVis) clearForecastPriceLines();

    // Trigger chart redraw so EMA/VWAP/etc. lines reflect toggle
    if (typeof updateChartIndicators === 'function') updateChartIndicators();
}
function wireIndicatorSwitches() {
    document.querySelectorAll('#indicator-grid input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
            STATE.indicators[cb.dataset.ind] = cb.checked;
            saveIndicators(STATE.indicators);
            applyIndicatorState();
        });
    });
    const allBtn = document.getElementById('ind-all');
    if (allBtn) allBtn.addEventListener('click', () => {
        const anyOff = Object.values(STATE.indicators).some(v => !v);
        for (const k of Object.keys(STATE.indicators)) STATE.indicators[k] = anyOff;
        saveIndicators(STATE.indicators);
        applyIndicatorState();
        allBtn.textContent = anyOff ? 'all on' : 'all off';
    });
}
setTimeout(() => { wireIndicatorSwitches(); applyIndicatorState(); }, 100);

// ============================================================
//  Always-visible forecast preview + pattern detector
//  Runs on the current candles even when no signal has fired.
//  Tells you "if you bought CALL now / PUT now, here's what AI sees"
// ============================================================
async function refreshForecastAndPatterns() {
    if (!STATE.candles?.length || STATE.candles.length < 60) return;
    const tfMinMap = { '1minute':1,'3minute':3,'5minute':5,'15minute':15,'30minute':30,'60minute':60,'1day':375 };
    const tfMin = tfMinMap[STATE.selectedTF] || 5;
    // Send up to 250 candles for full-series pattern scan
    const candleSlice = STATE.candles.slice(-250);
    const payload = JSON.stringify({ candles: candleSlice, tfMin });
    const scanPayload = JSON.stringify({ candles: candleSlice, minConf: 50, lookbackBars: 250 });
    const headers = { 'Content-Type': 'application/json' };

    // Run in parallel
    try {
        const [fc, pat, cpr, patScan] = await Promise.all([
            STATE.indicators.forecast ? fetch(STATE.market.backend + '/api/forecast/preview', { method:'POST', headers, body: payload }).then(r=>r.json()) : null,
            STATE.indicators.patterns ? fetch(STATE.market.backend + '/api/patterns',         { method:'POST', headers, body: payload }).then(r=>r.json()) : null,
            STATE.indicators.cpr      ? fetch(STATE.market.backend + '/api/cpr',              { method:'POST', headers, body: payload }).then(r=>r.json()) : null,
            STATE.indicators.patterns ? fetch(STATE.market.backend + '/api/patterns/scan',    { method:'POST', headers, body: scanPayload }).then(r=>r.json()) : null
        ]);
        renderForecastPreview(fc);
        renderPatternPanel(pat, patScan);
        renderCprPanel(cpr);
        drawForecastProjection(fc);
        drawPatternMarkers(patScan);    // ← paints pattern arrows on the chart
    } catch (e) { /* silent — keeps polling */ }
}

// ============================================================
//  Paint detected patterns as markers on the chart itself.
//  TradingView Lightweight Charts marker API:
//    position: aboveBar | belowBar | inBar
//    shape: arrowUp | arrowDown | circle | square
//    color, text
// ============================================================
// Whitelist — ONLY high-impact reversal/momentum patterns on chart.
// Common patterns (Marubozu, Hammer, Bull Eng on continuation) → side panel only.
const CHART_PATTERN_WHITELIST = new Set([
    'Morning Star', 'Evening Star',           // 3-candle reversals — rare & meaningful
    'Three Soldiers', 'Three Crows',          // sustained momentum confirmation
    'Bull Kicker', 'Bear Kicker',             // gap reversals — very high-impact
    'Shooting Star',                          // bearish exhaustion at top
    'Piercing Line', 'Dark Cloud'             // mid-trend reversals
]);
const MIN_CHART_PATTERN_CONF = 78;  // tighter floor — only confident calls reach the chart

function drawPatternMarkers(patScan) {
    if (!STATE.candleSeries) return;
    if (!STATE.indicators.patterns || !patScan?.markers?.length) {
        STATE.candleSeries.setMarkers(STATE.markers || []);
        return;
    }
    const shortName = (s) => s
        .replace('Bull Engulfing', 'Bull Eng')
        .replace('Bear Engulfing', 'Bear Eng')
        .replace('Shooting Star', 'Shooter')
        .replace('Morning Star', '★ Morning')
        .replace('Evening Star', '★ Evening')
        .replace('Three Soldiers', '3 Soldiers')
        .replace('Three Crows', '3 Crows')
        .replace('Bull Kicker', 'Kicker ↑')
        .replace('Bear Kicker', 'Kicker ↓')
        .replace('Piercing Line', 'Pierce')
        .replace('Dark Cloud', 'Dark Cloud')
        .replace('Rising 3 Methods', 'R3M')
        .replace('Falling 3 Methods', 'F3M');

    // FILTER: only impactful, high-confidence patterns hit the chart
    const filtered = patScan.markers.filter(m =>
        CHART_PATTERN_WHITELIST.has(m.type) && m.confidence >= MIN_CHART_PATTERN_CONF
    );

    // Further dedupe: cap to max 1 marker per candle (keep highest confidence)
    const perCandle = new Map();
    for (const m of filtered) {
        const ex = perCandle.get(m.time);
        if (!ex || ex.confidence < m.confidence) perCandle.set(m.time, m);
    }

    const patternMarkers = Array.from(perCandle.values()).map(m => ({
        time: m.time,
        position: m.bias === 'BULLISH' ? 'belowBar' : 'aboveBar',
        color: m.bias === 'BULLISH' ? 'rgba(0, 208, 156, 0.95)'
             : m.bias === 'BEARISH' ? 'rgba(235, 91, 60, 0.95)'
             : 'rgba(255, 178, 69, 0.85)',
        shape: m.bias === 'BULLISH' ? 'arrowUp' : 'arrowDown',
        text: shortName(m.type),
        size: m.confidence >= 85 ? 2 : 1
    }));

    const baseMarkers = STATE.markers || [];
    const merged = [...patternMarkers, ...baseMarkers].sort((a, b) => a.time - b.time);
    STATE.candleSeries.setMarkers(merged);
}
setTimeout(refreshForecastAndPatterns, 2200);
setInterval(refreshForecastAndPatterns, 5000);   // 5s — these are pure CPU on cached candles

// ============================================================
//  Capital Onboarding Modal — first visit asks for capital
//  Persisted to localStorage so it only shows once.
// ============================================================
function getCapitalSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('qe-capital') || 'null');
        if (saved && saved.capital && saved.risk) return saved;
    } catch (e) {}
    return null;
}
function saveCapitalSettings(capital, risk) {
    try {
        localStorage.setItem('qe-capital', JSON.stringify({ capital, risk, savedAt: Date.now() }));
    } catch (e) {}
    STATE.accountSize = capital;
    STATE.riskPercent = risk;
    cfg.capital = capital;
    cfg.risk = risk;
    syncCapitalIntoUI();
}
function syncCapitalIntoUI() {
    const cap = STATE.accountSize || 500000;
    const risk = STATE.riskPercent || 5;
    const capEl = document.getElementById('acct-capital');
    if (capEl) capEl.textContent = '₹' + cap.toLocaleString('en-IN');
    const riskEl = document.getElementById('acct-risk-display');
    if (riskEl) riskEl.textContent = risk.toFixed(0) + '%';
    const riskSlider = document.getElementById('acct-risk-slider');
    if (riskSlider) riskSlider.value = risk;
}

function showCapitalModal(force = false) {
    const modal = document.getElementById('capital-modal');
    if (!modal) return;
    const existing = getCapitalSettings();
    if (existing && !force) {
        STATE.accountSize = existing.capital;
        STATE.riskPercent = existing.risk;
        cfg.capital = existing.capital;
        cfg.risk = existing.risk;
        syncCapitalIntoUI();
        return;
    }
    modal.style.display = 'flex';
    const capInput = document.getElementById('cm-capital');
    const riskInput = document.getElementById('cm-risk');
    const riskVal = document.getElementById('cm-risk-val');
    const preview = document.getElementById('cm-preview');

    function update() {
        const cap = parseFloat(capInput.value) || 0;
        const risk = parseFloat(riskInput.value) || 0;
        const maxLoss = Math.round(cap * risk / 100);
        riskVal.textContent = risk.toFixed(0) + '%';
        preview.innerHTML = `Max loss per trade: <b>₹${maxLoss.toLocaleString('en-IN')}</b> · Engine sizes lots to fit this risk budget`;
    }
    update();
    capInput.addEventListener('input', update);
    riskInput.addEventListener('input', update);
    document.querySelectorAll('.cm-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            capInput.value = btn.dataset.amt;
            update();
        });
    });
    document.getElementById('cm-start').addEventListener('click', () => {
        const cap = parseFloat(capInput.value);
        const risk = parseFloat(riskInput.value);
        if (!cap || cap < 10000) { capInput.focus(); return; }
        saveCapitalSettings(cap, risk);
        modal.style.display = 'none';
    });
}
setTimeout(() => showCapitalModal(false), 200);
// Reopen via sidebar capital row click
setTimeout(() => {
    const capRow = document.getElementById('acct-capital')?.parentElement;
    if (capRow) capRow.addEventListener('click', () => showCapitalModal(true));
}, 500);

// ============================================================
//  Best Strike Now — always-visible, capital-aware top CALL + PUT
//  for the currently selected symbol with full greeks.
// ============================================================
async function refreshBestStrikeNow() {
    const wrap = document.getElementById('best-strike-now');
    const budgetEl = document.getElementById('bs-budget-mini');
    if (!wrap || !STATE.candles?.length || STATE.candles.length < 60) return;
    const cap = STATE.accountSize || cfg.capital || 200000;
    const risk = STATE.riskPercent || cfg.risk || 5;
    if (budgetEl) budgetEl.textContent = `₹${(cap/1000).toFixed(0)}k · ${risk}%`;

    const symbol = STATE.selectedSymbol;
    const candleSlice = STATE.candles.slice(-220);
    const headers = { 'Content-Type': 'application/json' };

    try {
        // Scan both sides in parallel
        const [callRes, putRes] = await Promise.all([
            fetch(`${STATE.market.backend}/api/strikes/scan`, {
                method: 'POST', headers,
                body: JSON.stringify({ symbol, side: 'BUY_CALL', candles: candleSlice, accountSize: cap, riskPercent: risk, iv: 0.18 })
            }).then(r => r.json()),
            fetch(`${STATE.market.backend}/api/strikes/scan`, {
                method: 'POST', headers,
                body: JSON.stringify({ symbol, side: 'BUY_PUT', candles: candleSlice, accountSize: cap, riskPercent: risk, iv: 0.18 })
            }).then(r => r.json())
        ]);
        const bestCall = callRes.candidates?.find(c => c.recommended) || callRes.candidates?.[0];
        const bestPut  = putRes.candidates?.find(c => c.recommended) || putRes.candidates?.[0];
        const callFc = callRes.forecast || {};
        const putFc  = putRes.forecast || {};

        // Decide which side has the AI edge — highlight the winner
        const callEdge = (callFc.pT1 || 50) - (callFc.pSL || 40);
        const putEdge  = (putFc.pT1 || 50) - (putFc.pSL || 40);
        const winner = callEdge >= putEdge ? 'call' : 'put';

        wrap.innerHTML = `
            <div class="bs-grid">
                ${bestCall ? renderStrikeMini('call', bestCall, callFc, winner === 'call') : '<div class="bs-empty">No CALL fits budget</div>'}
                ${bestPut  ? renderStrikeMini('put',  bestPut,  putFc,  winner === 'put')  : '<div class="bs-empty">No PUT fits budget</div>'}
            </div>
        `;
    } catch (e) {
        wrap.innerHTML = `<div class="bs-empty">Error: ${e.message}</div>`;
    }
}
function renderStrikeMini(side, c, fc, isWinner) {
    const cls = side === 'call' ? 'call' : 'put';
    const label = side === 'call' ? 'CALL' : 'PUT';
    const verdictClass = fc.verdict === 'FAVORABLE' ? 'fav' :
                         fc.verdict === 'UNFAVORABLE' ? 'unfav' :
                         fc.verdict === 'CHOP' ? 'chop' : 'neu';
    return `
        <div class="bs-card ${cls} ${isWinner ? 'winner' : ''} ${!c.fitsBudget ? 'over' : ''}">
            <div class="bs-head">
                <span class="bs-side">${label}</span>
                <span class="bs-strike">${c.strike}<small>${c.right}</small></span>
                ${isWinner ? '<span class="bs-winner-tag">⭐ AI EDGE</span>' : ''}
            </div>
            <div class="bs-prem-row">
                <span class="bs-prem">₹${c.premium.toFixed(2)}</span>
                <span class="bs-offset">${c.label}</span>
            </div>
            <div class="bs-greeks">
                <span><b>Δ</b> ${c.delta.toFixed(2)}</span>
                <span><b>Γ</b> ${c.gamma.toFixed(4)}</span>
                <span><b>Θ</b> ${c.theta.toFixed(1)}</span>
                <span><b>V</b> ${c.vega.toFixed(1)}</span>
            </div>
            <div class="bs-sizing">
                <span>${c.lots} lots × ${c.quantity/c.lots}</span>
                <span>Cap ${fmtCurrency(c.capitalRequired)}</span>
                <span>SL ${fmtCurrency(c.maxLossActual)}</span>
                <span>RR 1:${c.rr}</span>
            </div>
            ${fc.pT1 !== undefined ? `
                <div class="bs-ai">
                    <span class="bs-verdict-pill ${verdictClass}">${fc.verdict || '—'}</span>
                    <span>P(T1) <b class="green">${fc.pT1}%</b></span>
                    <span>P(SL) <b class="red">${fc.pSL}%</b></span>
                </div>
            ` : ''}
            ${!c.fitsBudget ? '<div class="bs-warn">⚠ Over budget · reduce lots manually</div>' : ''}
        </div>
    `;
}
setTimeout(refreshBestStrikeNow, 3000);
setInterval(refreshBestStrikeNow, 8000);

// ============================================================
//  Insights tabs (Forecast / Pattern / CPR) — cleaner than 3 stacked cards
// ============================================================
function wireInsightsTabs() {
    const tabs = document.querySelectorAll('.insights-tab');
    const panels = document.querySelectorAll('.insights-panel');
    if (!tabs.length) return;
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            tabs.forEach(t => t.classList.toggle('active', t === tab));
            panels.forEach(p => p.classList.toggle('active', p.dataset.tab === target));
        });
    });
}
setTimeout(wireInsightsTabs, 150);

// ============================================================
//  Draw the AI forecast as a price-projection cone on the chart.
//  Called from refreshForecastAndPatterns after fetch.
//
//  Geometry:
//    • Anchor = last closed candle close
//    • Project N candles forward at TF interval
//    • Cone widens linearly from anchor to MFE/MAE bounds
//    • Center drifts toward the higher-probability side
// ============================================================
function drawForecastProjection(fc) {
    if (!STATE.candleSeries || !STATE.candles?.length) return;
    if (!STATE.indicators.forecast) {
        STATE.forecastUpperSeries?.setData([]);
        STATE.forecastLowerSeries?.setData([]);
        STATE.forecastCenterSeries?.setData([]);
        STATE.forecastConeArea?.setData([]);
        clearForecastPriceLines();
        const lg = document.getElementById('forecast-chart-legend');
        if (lg) lg.remove();
        return;
    }
    if (!fc || !fc.call || !fc.put) return;

    const tfMinMap = { '1minute':1,'3minute':3,'5minute':5,'15minute':15,'30minute':30,'60minute':60,'1day':375 };
    const tfMin = tfMinMap[STATE.selectedTF] || 5;
    const tfSec = tfMin * 60;
    const last = STATE.candles[STATE.candles.length - 1];
    const anchorTime = last.time;
    const anchorPrice = last.close;

    // Pick the dominant side based on AI suggestion or higher edge
    const callEdge = fc.call.pT1 - fc.call.pSL;
    const putEdge  = fc.put.pT1 - fc.put.pSL;
    const dominantSide = fc.suggestion === 'CALL_BIAS' ? 'call' :
                         fc.suggestion === 'PUT_BIAS'  ? 'put'  :
                         (callEdge >= putEdge ? 'call' : 'put');
    const fcSide = fc[dominantSide];

    // Project forward — number of candles ≈ model's lookahead (12 candles default)
    const N_FORWARD = 12;
    const upMovePct  = fcSide.expectedMfePct / 100;
    const downMovePct = fcSide.expectedMaePct / 100;

    // Direction: CALL→price moves UP for favorable; PUT→price moves DOWN for favorable
    const favIsUp = dominantSide === 'call';

    // Convert to absolute prices
    // Upper bound = if anchor moves favorably the FULL expected MFE
    // Lower bound = if anchor moves adversely the FULL expected MAE
    const favEnd  = favIsUp ? anchorPrice * (1 + upMovePct)  : anchorPrice * (1 - upMovePct);
    const advEnd  = favIsUp ? anchorPrice * (1 - downMovePct) : anchorPrice * (1 + downMovePct);

    // Center drift weighted by P(T1)-P(SL): if AI is strongly favorable,
    // center moves toward favEnd; otherwise stays closer to anchor
    const driftWeight = (fcSide.pT1 - fcSide.pSL) / 100;  // -1..+1
    const centerEnd = anchorPrice + (favEnd - anchorPrice) * Math.max(0, driftWeight);

    // Build series data — cone widens linearly with time
    const upperData = [];
    const lowerData = [];
    const centerData = [];
    const coneAreaData = [];
    for (let i = 0; i <= N_FORWARD; i++) {
        const t = anchorTime + i * tfSec;
        const fraction = i / N_FORWARD;
        const upper = anchorPrice + (favEnd - anchorPrice) * fraction;
        const lower = anchorPrice + (advEnd - anchorPrice) * fraction;
        const center = anchorPrice + (centerEnd - anchorPrice) * fraction;
        upperData.push({ time: t, value: favIsUp ? upper : lower });
        lowerData.push({ time: t, value: favIsUp ? lower : upper });
        centerData.push({ time: t, value: center });
        // Area series uses single value — we use the favourable bound
        coneAreaData.push({ time: t, value: favIsUp ? upper : lower });
    }

    STATE.forecastUpperSeries.setData(upperData);
    STATE.forecastLowerSeries.setData(lowerData);
    STATE.forecastCenterSeries.setData(centerData);
    STATE.forecastConeArea.setData(coneAreaData);

    // Recolor center line by verdict
    const verdictColor = fcSide.verdict === 'FAVORABLE' ? 'rgba(0, 208, 156, 0.95)' :
                         fcSide.verdict === 'UNFAVORABLE' ? 'rgba(235, 91, 60, 0.95)' :
                         fcSide.verdict === 'CHOP' ? 'rgba(255, 178, 69, 0.95)' :
                                                     'rgba(77, 125, 255, 0.85)';
    STATE.forecastCenterSeries.applyOptions({ color: verdictColor });

    // Horizontal target/stop price lines — clearer labels with the actual price
    clearForecastPriceLines();
    const tgtPct = upMovePct * 100;
    const stpPct = downMovePct * 100;
    const sign = favIsUp ? '+' : '-';
    const stpSign = favIsUp ? '-' : '+';
    STATE.forecastTargetLines.push(STATE.candleSeries.createPriceLine({
        price: favEnd, color: 'rgba(0, 208, 156, 0.95)', lineWidth: 2, lineStyle: 2,
        axisLabelVisible: true, title: `🎯 AI Target  ${sign}${tgtPct.toFixed(2)}%  →  ${favEnd.toFixed(2)}`
    }));
    STATE.forecastTargetLines.push(STATE.candleSeries.createPriceLine({
        price: advEnd, color: 'rgba(235, 91, 60, 0.95)', lineWidth: 2, lineStyle: 2,
        axisLabelVisible: true, title: `🛑 AI Stop  ${stpSign}${stpPct.toFixed(2)}%  →  ${advEnd.toFixed(2)}`
    }));
    STATE.forecastTargetLines.push(STATE.candleSeries.createPriceLine({
        price: anchorPrice, color: 'rgba(77, 125, 255, 0.85)', lineWidth: 1, lineStyle: 0,
        axisLabelVisible: true, title: `📍 Anchor (now)  ${anchorPrice.toFixed(2)}`
    }));
    // Floating chart legend removed — explainer lives in side panel ⓘ button.
    // Remove any leftover legend element from a previous render.
    document.getElementById('forecast-chart-legend')?.remove();
}
function clearForecastPriceLines() {
    if (!STATE.candleSeries) return;
    (STATE.forecastTargetLines || []).forEach(l => {
        try { STATE.candleSeries.removePriceLine(l); } catch (_) {}
    });
    STATE.forecastTargetLines = [];
}

function renderForecastPreview(fc) {
    const el = document.getElementById('forecast-preview');
    if (!el) return;
    if (!fc || !fc.call) { el.innerHTML = ''; return; }
    const c = fc.call, p = fc.put;
    const suggestClass = fc.suggestion === 'CALL_BIAS' ? 'call' :
                         fc.suggestion === 'PUT_BIAS' ? 'put' : 'neutral';
    const suggestLabel = fc.suggestion === 'CALL_BIAS' ? '↑ AI prefers CALL' :
                         fc.suggestion === 'PUT_BIAS'  ? '↓ AI prefers PUT'  : '↔ AI sees no edge';

    // Plain-language summary — what does this mean for the trader RIGHT NOW?
    const dom = fc.suggestion === 'PUT_BIAS' ? p : c;
    const domLabel = fc.suggestion === 'PUT_BIAS' ? 'PUT' : 'CALL';
    let plain;
    if (fc.suggestion === 'NEUTRAL') {
        plain = `Neither side has a clear edge right now. AI suggests waiting for a higher-conviction setup.`;
    } else if (dom.verdict === 'FAVORABLE') {
        plain = `If you buy ${domLabel} now, AI expects price to move <b class="green">+${dom.expectedMfePct}%</b> in your favor before pulling back <b class="red">${dom.expectedMaePct}%</b> against you. <b>${dom.pT1}%</b> chance the target hits first vs <b>${dom.pSL}%</b> chance the stop hits first.`;
    } else if (dom.verdict === 'CHOP') {
        plain = `AI expects sideways chop — ${domLabel} side has a slight edge but most moves time out. Best to wait.`;
    } else {
        plain = `AI sees ${dom.pT1}% chance of hitting target vs ${dom.pSL}% chance of hitting stop — too close to call confidently.`;
    }

    el.innerHTML = `
        <div class="fcp-wrap">
            <div class="fcp-head">
                <span class="fcp-title">🧠 AI Forecast — What if I trade NOW? <button class="fcp-info" id="fcp-info-btn" title="How does this work?">ⓘ</button></span>
                <span class="fcp-suggest ${suggestClass}">${suggestLabel}</span>
            </div>
            <div class="fcp-plain">${plain}</div>
            <div class="fcp-grid">
                <div class="fcp-side call ${fc.suggestion === 'CALL_BIAS' ? 'best' : ''}">
                    <div class="fcp-side-head">BUY CALL</div>
                    <div class="fcp-row"><span>P(T1 hit)</span><b class="green">${c.pT1.toFixed(0)}%</b></div>
                    <div class="fcp-row"><span>P(SL hit)</span><b class="red">${c.pSL.toFixed(0)}%</b></div>
                    <div class="fcp-row"><span>Expected up move</span><b class="green">+${c.expectedMfePct.toFixed(2)}%</b></div>
                    <div class="fcp-row"><span>Expected down risk</span><b class="red">-${c.expectedMaePct.toFixed(2)}%</b></div>
                    <div class="fcp-row"><span>Verdict</span><b>${c.verdict}</b></div>
                </div>
                <div class="fcp-side put ${fc.suggestion === 'PUT_BIAS' ? 'best' : ''}">
                    <div class="fcp-side-head">BUY PUT</div>
                    <div class="fcp-row"><span>P(T1 hit)</span><b class="green">${p.pT1.toFixed(0)}%</b></div>
                    <div class="fcp-row"><span>P(SL hit)</span><b class="red">${p.pSL.toFixed(0)}%</b></div>
                    <div class="fcp-row"><span>Expected down move</span><b class="green">+${p.expectedMfePct.toFixed(2)}%</b></div>
                    <div class="fcp-row"><span>Expected up risk</span><b class="red">-${p.expectedMaePct.toFixed(2)}%</b></div>
                    <div class="fcp-row"><span>Verdict</span><b>${p.verdict}</b></div>
                </div>
            </div>
            <div class="fcp-foot">Tier base rates from 10yr data · refreshed every 5s · ${c.source}</div>
        </div>
    `;
    // Wire the ⓘ button
    const btn = document.getElementById('fcp-info-btn');
    if (btn) btn.onclick = () => {
        const m = document.getElementById('fc-explainer');
        if (m) m.style.display = 'flex';
    };
}

// Wire close button + backdrop click for explainer modal
setTimeout(() => {
    const closeBtn = document.getElementById('fc-explainer-close');
    const modal = document.getElementById('fc-explainer');
    if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
}, 200);

function renderPatternPanel(pat, scan) {
    const el = document.getElementById('pattern-panel');
    if (!el) return;
    const formingTop = pat?.patterns?.slice(0, 2) || [];
    const formingNote = pat?.summary?.note || '';
    const progress = Math.round((pat?.candleProgress || 0) * 100);
    const scanCount = scan?.count || 0;
    const bull = scan?.bullish || 0;
    const bear = scan?.bearish || 0;
    const latest = scan?.latest5 || [];

    if (!scanCount && !formingTop.length) {
        el.innerHTML = `<div class="pat-empty">No patterns found · candle ${progress}% complete</div>`;
        return;
    }
    el.innerHTML = `
        <div class="pat-wrap">
            <div class="pat-head">
                <span class="pat-title">📊 Patterns on Chart</span>
                <span class="pat-progress">${scanCount} found · ${progress}% candle</span>
            </div>
            <div class="pat-counts">
                <span class="pc-bull">↑ ${bull} Bullish</span>
                <span class="pc-bear">↓ ${bear} Bearish</span>
            </div>
            ${formingTop.length ? `
                <div class="pat-section-label">FORMING NOW</div>
                ${formingTop.map(p => {
                    const cls = p.bias === 'BULLISH' ? 'bull' : p.bias === 'BEARISH' ? 'bear' : 'neutral';
                    return `<div class="pat-row ${cls}">
                        <div class="pat-name-row">
                            <span class="pat-name">${p.pattern}</span>
                            <span class="pat-bias-pill ${cls}">${p.bias === 'BULLISH' ? '↑' : p.bias === 'BEARISH' ? '↓' : '·'}</span>
                            <span class="pat-conf">${p.confidence}%</span>
                        </div>
                        <div class="pat-note">${p.note}</div>
                    </div>`;
                }).join('')}
            ` : ''}
            ${latest.length ? `
                <div class="pat-section-label">RECENT</div>
                ${latest.map(m => {
                    const cls = m.bias === 'BULLISH' ? 'bull' : m.bias === 'BEARISH' ? 'bear' : 'neutral';
                    const t = new Date(m.time * 1000);
                    const ist = new Date(t.getTime() + (5*60+30)*60*1000);
                    const ts = String(ist.getUTCHours()).padStart(2,'0') + ':' + String(ist.getUTCMinutes()).padStart(2,'0');
                    return `<div class="pat-row mini ${cls}">
                        <span class="pat-time">${ts}</span>
                        <span class="pat-name">${m.type}</span>
                        <span class="pat-bias-pill ${cls}">${m.bias === 'BULLISH' ? '↑' : m.bias === 'BEARISH' ? '↓' : '·'}</span>
                        <span class="pat-conf">${m.confidence}%</span>
                    </div>`;
                }).join('')}
            ` : ''}
            ${formingNote ? `<div class="pat-foot">${formingNote}</div>` : ''}
        </div>
    `;
}

function renderCprPanel(cpr) {
    const el = document.getElementById('cpr-panel');
    if (!el) return;
    if (!cpr || !cpr.daily) { el.innerHTML = ''; return; }
    const d = cpr.daily;
    const typeClass = d.dayType === 'NARROW' ? 'narrow' : d.dayType === 'WIDE' ? 'wide' : 'medium';
    const typeNote = d.dayType === 'NARROW' ? '→ Trending day likely (CPR breakout strategies preferred)' :
                     d.dayType === 'WIDE'   ? '→ Range day likely (CPR reversal at TC/BC preferred)' :
                                              '→ Mixed — wait for confirmation';
    el.innerHTML = `
        <div class="cpr-wrap">
            <div class="cpr-head">
                <span class="cpr-title">📍 CPR (Central Pivot Range) — Daily</span>
                <span class="cpr-type ${typeClass}">${d.dayType} · ${d.widthPct.toFixed(2)}%</span>
            </div>
            <div class="cpr-note">${typeNote}</div>
            <div class="cpr-levels">
                <div class="cpr-lvl r3"><span>R3</span><b>${d.R3.toFixed(2)}</b></div>
                <div class="cpr-lvl r2"><span>R2</span><b>${d.R2.toFixed(2)}</b></div>
                <div class="cpr-lvl r1"><span>R1</span><b>${d.R1.toFixed(2)}</b></div>
                <div class="cpr-lvl tc"><span>TC</span><b>${d.TC.toFixed(2)}</b></div>
                <div class="cpr-lvl p"><span>Pivot</span><b>${d.pivot.toFixed(2)}</b></div>
                <div class="cpr-lvl bc"><span>BC</span><b>${d.BC.toFixed(2)}</b></div>
                <div class="cpr-lvl s1"><span>S1</span><b>${d.S1.toFixed(2)}</b></div>
                <div class="cpr-lvl s2"><span>S2</span><b>${d.S2.toFixed(2)}</b></div>
                <div class="cpr-lvl s3"><span>S3</span><b>${d.S3.toFixed(2)}</b></div>
            </div>
            ${cpr.proximity?.nearest ? `
                <div class="cpr-near">Nearest: <b>${cpr.proximity.nearest.name}</b> ${cpr.proximity.nearest.price.toFixed(2)} (${cpr.proximity.nearest.distPct.toFixed(2)}% away)</div>
            ` : ''}
        </div>
    `;
}

// ============================================================
//  AI Rationale — runs confluence eval + renders breakdown
// ============================================================
async function refreshAIRationale() {
    const el = document.getElementById('ai-rationale');
    const chip = document.getElementById('ai-model-chip');
    if (!el || STATE.candles.length < 50) return;
    try {
        // Light call — only send last 220 candles
        const r = await fetch(STATE.market.backend + '/api/signals/confluence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: STATE.selectedSymbol,
                candles: STATE.candles.slice(-220),
                vix: STATE.indianVIX,
                accountSize: cfg.capital,
                riskPercent: cfg.risk,
                minScore: cfg.minAiScore ?? 0   // God Mode default = 0 (all signals)
            })
        });
        if (!r.ok) throw new Error('eval failed');
        const data = await r.json();

        // Model chip
        if (chip) {
            const ready = data.modelStatus === 'node-local';
            chip.textContent = ready ? 'ML READY' : 'OFFLINE';
            chip.className = 'ai-model-chip ' + (ready ? 'ready' : '');
        }

        // If server suppressed the signal due to low AI score, downgrade
        // the UI badge to "GATED" so user knows engine FOUND something but
        // wasn't confident enough to surface it.
        const sideClass = data.suppressed ? 'gated' : data.side === 'BUY_CALL' ? 'call' : data.side === 'BUY_PUT' ? 'put' : 'no';
        const sideLabel = data.suppressed
            ? `🚫 GATED (score ${data.approval?.finalScore || '?'} < ${data.minScoreUsed})`
            : data.side === 'BUY_CALL' ? '🟢 BUY CALL'
            : data.side === 'BUY_PUT'  ? '🔴 BUY PUT'
            : '⚪ NO TRADE';

        const mlScore = data.mlScore;
        const newsAdj = data.newsAdjustment || {};

        // CLEAN version — only firing strategies, no vote spam
        const firing = data.votes.filter(v => v.fired);
        const totalVotes = data.votes.length;

        el.innerHTML = `
            <div class="ai-verdict">
                <span class="ai-verdict-side ${sideClass}">${sideLabel} · ${data.tier || ''}</span>
                <span class="ai-verdict-score">${data.confluenceScore}%</span>
            </div>

            ${firing.length > 0 ? `
                <div class="ai-block">
                    <div class="ai-block-title">Firing Strategies (${firing.length} / ${totalVotes})</div>
                    ${firing.map(v => `<div class="ai-vote fired ${v.side === 'BUY_CALL' ? 'call' : 'put'}">
                        <span class="ai-vote-icon fire">●</span>
                        <div class="ai-vote-body">
                            <span class="ai-vote-name">${v.name}</span>
                            <span class="ai-vote-reason">${v.reason || '—'}</span>
                        </div>
                        <span class="ai-vote-weight">${(v.weight ?? 0).toFixed(1)}</span>
                    </div>`).join('')}
                </div>
            ` : `
                <div class="ai-block">
                    <div class="ai-block-title">Status</div>
                    <div style="padding:8px 10px;color:var(--text-3);font-size:11px;font-family:var(--font-mono)">
                        Watching · 0 / ${totalVotes} strategies firing · scores C${data.callScore.toFixed(0)} / P${data.putScore.toFixed(0)}
                    </div>
                </div>
            `}

            <div class="ai-block ai-block-compact">
                <span>Regime: <b>${data.regime?.regime || '?'}</b></span>
                <span>News: <b class="${newsAdj.call > 0 ? 'pos' : newsAdj.put > 0 ? 'neg' : ''}">${newsAdj.call > 0 ? '+' + newsAdj.call.toFixed(0) + ' CE' : newsAdj.put > 0 ? '+' + newsAdj.put.toFixed(0) + ' PE' : 'neutral'}</b></span>
                ${mlScore && !mlScore.error ? `<span>ML: <b class="${mlScore.winProbabilityPct >= 55 ? 'pos' : mlScore.winProbabilityPct < 50 ? 'neg' : ''}">${mlScore.winProbabilityPct}% win</b></span>` : ''}
            </div>


            ${data.blockedReasons?.length ? `
                <div class="ai-block">
                    <div class="ai-block-title" style="color:var(--neon-red)">⛔ Blocked Reasons</div>
                    ${data.blockedReasons.map(r => `<div class="ai-vote-reason" style="padding:5px 8px;background:var(--neon-red-soft);border-radius:2px">${r}</div>`).join('')}
                </div>
            ` : ''}
        `;

        // Render Possible Signals (top near-misses) — use the SAME response
        renderPossibleSignals(data.possibles || []);

        // Render the FULL actionable signal card if we have one
        if (data.actionable) {
            renderActionableSignal(data.actionable, data.forecast, data.approval, data.strikeOptions, data.expiry);
        } else {
            // Only show idle if there's no live active trade
            if (!STATE.activeTrade) renderIdleSignal();
        }
    } catch (e) {
        if (el) el.innerHTML = `<div class="ai-empty">Error: ${e.message}</div>`;
    }
}

// ============================================================
//  Actionable signal card (with SL/TP/Strike) + Enter Trade button
// ============================================================
function renderApprovalBlock(approval) {
    if (!approval) return '';
    const dec = approval.decision;
    const gradeClass = approval.grade === 'A+' ? 'gAplus' :
                       approval.grade === 'A'  ? 'gA' :
                       approval.grade === 'B'  ? 'gB' :
                       approval.grade === 'C'  ? 'gC' : 'gAvoid';
    const decClass = dec === 'APPROVE' ? 'approve' : dec === 'WATCHLIST' ? 'watch' : 'reject';
    const regimeLabel = approval.regimeDetails?.displayLabel || approval.regimeDetails?.regime || '—';

    const layers = approval.layerScores || {};
    const layerOrder = [
        ['Trend','trend'], ['Volume','volume'], ['VWAP','vwap'], ['EMA','ema'],
        ['Options','options'], ['PCR','pcr'], ['OI','oi'], ['News','news'],
        ['Volatility','volatility'], ['Liquidity','liquidity'], ['Regime','regime'],
        ['MTF','mtf'], ['Time','timeOfDay']
    ];

    return `
        <div class="approval-block ${decClass}">
            <div class="approval-head">
                <div class="approval-score-wrap">
                    <span class="approval-label">AI Approval Score</span>
                    <span class="approval-score">${approval.finalScore}<small>/100</small></span>
                </div>
                <div class="approval-meta">
                    <span class="approval-grade ${gradeClass}">${approval.grade}</span>
                    <span class="approval-decision ${decClass}">${dec}</span>
                </div>
            </div>
            <div class="approval-sub">
                Regime: <b>${regimeLabel}</b> · RR <b>1:${approval.rr}</b> · ${approval.passedLayers}/5 confirmation layers
                ${approval.calibration?.samples > 0 ? `· Calibrated: <b>${approval.calibratedScore}</b> (${approval.calibration.samples} prior trades)` : ''}
            </div>
            ${approval.reasons?.length ? `
                <div class="approval-list reasons">
                    <div class="approval-list-title">✓ Reasons</div>
                    ${approval.reasons.map(r => `<div class="approval-row">• ${r}</div>`).join('')}
                </div>
            ` : ''}
            ${approval.risks?.length ? `
                <div class="approval-list risks">
                    <div class="approval-list-title">⚠ Risks</div>
                    ${approval.risks.map(r => `<div class="approval-row">• ${r}</div>`).join('')}
                </div>
            ` : ''}
            ${approval.vetoes?.length ? `
                <div class="approval-list vetoes">
                    <div class="approval-list-title">⛔ Veto Triggers</div>
                    ${approval.vetoes.map(r => `<div class="approval-row">• ${r}</div>`).join('')}
                </div>
            ` : ''}
            <div class="approval-layers">
                ${layerOrder.map(([lbl,k]) => {
                    const v = layers[k] || 0;
                    const c = v >= 75 ? 'good' : v >= 60 ? 'ok' : v >= 40 ? 'mid' : 'bad';
                    return `<div class="approval-layer ${c}" title="${lbl}: ${v}"><span class="al-l">${lbl}</span><span class="al-v">${v}</span></div>`;
                }).join('')}
            </div>
        </div>
    `;
}

// Render multi-strike scanner — 3-5 best candidates that fit your budget
function renderStrikeOptions(opts, sig) {
    if (!opts || !opts.candidates?.length) return '';
    const cands = opts.candidates;
    return `
        <div class="strike-scanner">
            <div class="ss-head">
                <span class="ss-title">💰 Budget-Aware Strike Picker</span>
                <span class="ss-sub">Spot ${opts.spot.toFixed(2)} · ATM ${opts.atmStrike} · DTE ${opts.dte}d · Budget ₹${(opts.budget.maxLoss/1000).toFixed(1)}k</span>
            </div>
            <div class="ss-grid">
                ${cands.map((c, i) => `
                    <div class="ss-card ${c.recommended ? 'best' : ''} ${!c.fitsBudget ? 'over-budget' : ''}">
                        <div class="ss-card-head">
                            <span class="ss-offset">${c.label}</span>
                            ${c.recommended ? '<span class="ss-best-badge">⭐ BEST</span>' : ''}
                            ${!c.fitsBudget ? '<span class="ss-over">over budget</span>' : ''}
                        </div>
                        <div class="ss-strike-row">
                            <span class="ss-strike">${c.strike}<small>${c.right}</small></span>
                            <span class="ss-premium">₹${c.premium.toFixed(2)}</span>
                        </div>
                        <div class="ss-row"><span>SL</span><b class="red">₹${c.slPrem}</b></div>
                        <div class="ss-row"><span>T1</span><b class="green">₹${c.t1Prem}</b></div>
                        <div class="ss-row"><span>T2</span><b class="green">₹${c.t2Prem}</b></div>
                        <div class="ss-row"><span>Lots</span><b>${c.lots} × ${(c.quantity/c.lots)}</b></div>
                        <div class="ss-row"><span>Capital</span><b>${fmtCurrency(c.capitalRequired)}</b></div>
                        <div class="ss-row"><span>Max Loss</span><b class="red">${fmtCurrency(c.maxLossActual)}</b></div>
                        <div class="ss-row"><span>RR · Δ · Γ</span><b>1:${c.rr} · ${c.delta.toFixed(2)} · ${c.gamma.toFixed(4)}</b></div>
                        ${c.note ? `<div class="ss-note">${c.note}</div>` : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderActionableSignal(sig, forecast, approval, strikeOptions, expiry) {
    const wrap = document.getElementById('signal-card-wrap');
    if (!wrap) return;
    const isCall = sig.side === 'BUY_CALL';
    const cls = isCall ? '' : 'put';
    const score = approval?.finalScore ?? sig.confluenceScore ?? 0;
    // Expiry Day Elite block — show prominently if institutional tier
    const eliteBlock = expiry?.isExpiry ? `
        <div class="elite-block tier-${(expiry.tier || 'watch').toLowerCase()}">
            <div class="eb-head">
                <span class="eb-icon">${expiry.tier === 'ELITE' ? '⭐' : expiry.tier === 'STRONG' ? '✓' : '·'}</span>
                <span class="eb-tier">${expiry.tier} EXPIRY SETUP</span>
                <span class="eb-meta">DTE ${expiry.dte}d · Max Pain ${expiry.maxPain || '-'} · PCR ${expiry.pcr || '-'}</span>
            </div>
            ${expiry.confirmations?.length ? `
                <div class="eb-section ok">
                    <b>✓ Confirmations (${expiry.confirmations.length})</b>
                    ${expiry.confirmations.map(c => `<div>• ${c}</div>`).join('')}
                </div>` : ''}
            ${expiry.warnings?.length ? `
                <div class="eb-section warn">
                    <b>⚠ Warnings (${expiry.warnings.length})</b>
                    ${expiry.warnings.map(w => `<div>• ${w}</div>`).join('')}
                </div>` : ''}
        </div>
    ` : '';
    const grade = approval?.grade || (score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D');
    const scoreCls = score >= 70 ? 'good' : score >= 50 ? 'mid' : 'weak';

    // One-sentence rationale — show WHY the engine fired this
    const firing = (sig.firingStrategies || []).map(s => s.name);
    const fcVerdict = forecast?.verdict || '—';
    let why = '';
    if (firing.length) {
        why = `${firing.length} strateg${firing.length>1?'ies':'y'} firing (${firing.slice(0,2).join(' · ')}${firing.length>2?'…':''})`;
        if (forecast) why += ` · AI ${fcVerdict.toLowerCase()} (P(T1) ${forecast.pT1}%)`;
    }

    // Stash the signal on window so the onclick handler reads it by reference
    // (inline JSON-in-onclick breaks on quotes inside nested objects).
    window._pendingSig = sig;
    window._pendingApproval = approval;
    const enterBtn = approval?.decision === 'REJECT'
        ? `<button class="btn-enter-trade rejected" onclick="window.enterTradeFromCard('REJECT')">⛔ Override · Enter Anyway</button>`
        : approval?.decision === 'WATCHLIST'
        ? `<button class="btn-enter-trade watchlist" onclick="window.enterTradeFromCard('WATCHLIST')">⚠ Watchlist · Enter</button>`
        : `<button class="btn-enter-trade" onclick="window.enterTradeFromCard('APPROVE')">▶ Enter Trade</button>`;

    wrap.innerHTML = `
        <div class="signal-card-clean ${cls}">
            <!-- ── HEAD: side + strike + score ── -->
            <div class="scc-head">
                <span class="scc-side">${isCall ? '🟢 BUY CALL' : '🔴 BUY PUT'}</span>
                <span class="scc-strike">${sig.option.strike}<small>${sig.option.right}</small></span>
                <span class="scc-score ${scoreCls}">${score}/100 · ${grade}</span>
            </div>

            <!-- ── ELITE EXPIRY BLOCK (top priority if present) ── -->
            ${eliteBlock}

            <!-- ── WHY (one-line rationale) ── -->
            ${why ? `<div class="scc-why">${why}</div>` : ''}

            <!-- ── KEY NUMBERS (entry / SL / T1 / T2) ── -->
            <div class="scc-prices">
                <div class="scc-prc">
                    <span>Entry</span>
                    <b>₹${sig.option.premium.toFixed(2)}</b>
                </div>
                <div class="scc-prc red">
                    <span>Stop Loss</span>
                    <b>₹${sig.option.premiumSL.toFixed(2)}</b>
                </div>
                <div class="scc-prc green">
                    <span>Target 1</span>
                    <b>₹${sig.option.premiumT1.toFixed(2)}</b>
                </div>
                <div class="scc-prc green">
                    <span>Target 2</span>
                    <b>₹${sig.option.premiumT2.toFixed(2)}</b>
                </div>
            </div>

            <!-- ── SIZING (lots + capital + max loss) ── -->
            <div class="scc-sizing">
                <span>Lots <b>${sig.sizing.lots} × ${sig.option.lotSize || (sig.sizing.quantity/sig.sizing.lots)}</b></span>
                <span>Capital <b>${fmtCurrency(sig.sizing.capitalRequired)}</b></span>
                <span>Max Loss <b class="red">${fmtCurrency(sig.sizing.maxLoss)}</b></span>
                <span>R:R <b>1:${sig.riskReward.toFixed(1)}</b></span>
            </div>

            <!-- ── SPOT LEVELS (entry/SL/T1/T2 on the underlying) ── -->
            <div class="scc-spot">
                Spot entry ${sig.spot.entry} → SL ${sig.spot.stopLoss} · T1 ${sig.spot.target1} · T2 ${sig.spot.target2}
            </div>

            <!-- ── ACTION BUTTON ── -->
            <div class="scc-actions">${enterBtn}</div>

            <!-- ── DETAILS (collapsed by default) ── -->
            <details class="scc-details">
                <summary>▸ Show AI analysis, greeks &amp; alternatives</summary>
                <div class="scc-details-body">
                    ${approval ? renderApprovalBlock(approval) : ''}
                    ${forecast ? renderForecastBlock(forecast) : ''}
                    ${strikeOptions ? renderStrikeOptions(strikeOptions, sig) : ''}
                </div>
            </details>
        </div>
    `;
}

// Click handler for the signal-card Enter Trade button.
// Reads sig from window._pendingSig (set by renderActionableSignal)
// to avoid inline-JSON quote-escaping bugs.
window.enterTradeFromCard = function(decision) {
    const sig = window._pendingSig;
    const approval = window._pendingApproval;
    if (!sig) {
        toast('Signal data missing — refresh the page', 'error');
        return;
    }
    if (decision === 'REJECT') {
        if (!confirm(`AI flagged this trade as REJECT (score ${approval?.finalScore || '?'}/100).\n\nOverride and enter anyway?`)) return;
    } else if (decision === 'WATCHLIST') {
        if (!confirm(`WATCHLIST setup · score ${approval?.finalScore || '?'}/100.\n\nEnter the trade anyway?`)) return;
    }
    window.enterTrade(sig);
};

window.enterTrade = async function(sig) {
    try {
        const r = await fetch(STATE.market.backend + '/api/active-trade/enter', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sig)
        });
        const data = await r.json();
        STATE.activeTrade = data.active;
        toast('Trade entered — monitoring for exit signals', 'success');
        refreshTradeMonitor();
    } catch (e) {
        toast('Failed to enter trade: ' + e.message, 'error');
    }
};

window.exitActiveTrade = async function(reason) {
    if (!confirm('Close this trade?')) return;
    try {
        // Pass live premium + spot estimate so server-side history saves
        // real P&L instead of a flat zero.
        const exitPremium = STATE.lastMonitor?.premEstimate ?? null;
        const spotExit = STATE.lastMonitor?.spotNow ?? null;
        await fetch(STATE.market.backend + '/api/active-trade/exit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || 'manual', exitPremium, spotExit })
        });
        STATE.activeTrade = null;
        STATE.lastMonitor = null;
        toast('Trade closed', 'success');
        document.getElementById('trade-monitor').innerHTML = '';
    } catch (e) {
        toast('Failed to exit: ' + e.message, 'error');
    }
};

// ============================================================
//  Greeks pill — live Δ Γ Θ V from Black-Scholes
// ============================================================
function renderGreeksPill(g, gb) {
    if (!g || !g.valid) return '';
    return `
        <div class="greeks-pill">
            <span class="gp-label">LIVE GREEKS</span>
            <span class="gp-item"><b>Δ</b> ${g.delta.toFixed(3)}</span>
            <span class="gp-item"><b>Γ</b> ${g.gamma.toFixed(5)}</span>
            <span class="gp-item theta"><b>Θ</b> ${g.theta.toFixed(2)}/day</span>
            <span class="gp-item"><b>V</b> ${g.vega.toFixed(2)}/1%</span>
            ${gb ? `<span class="gp-item dte">DTE ${gb.dte}d</span>` : ''}
            ${gb ? `<span class="gp-item bs">BS₹${gb.bsPrice.toFixed(2)}</span>` : ''}
        </div>
    `;
}

// ============================================================
//  Gamma Blast banner — only when active
// ============================================================
function renderGammaBlastBanner(gb) {
    if (!gb || !gb.active) return '';
    const sev = gb.severity;
    const cls = sev >= 75 ? 'critical' : sev >= 55 ? 'high' : 'warn';
    return `
        <div class="gamma-blast ${cls}">
            <div class="gb-head">
                <span class="gb-icon">${sev >= 75 ? '🚀' : sev >= 55 ? '🔥' : '⚠'}</span>
                <span class="gb-title">${gb.label} · severity ${sev}</span>
            </div>
            <div class="gb-body">
                ${gb.action}
                <div class="gb-stats">
                    <span>Γ ${gb.gamma.toFixed(5)}</span>
                    <span>DTE ${gb.dte}d</span>
                    <span>Moneyness ${gb.moneyness.toFixed(2)}%</span>
                    <span>0.1% spot → ${gb.expectedMoveFor0p1Pct}% premium</span>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
//  Profit playbook — concrete next-action rules
// ============================================================
function renderPlaybookBlock(pb) {
    if (!pb || !pb.rules?.length) return '';
    return `
        <div class="playbook-block">
            <div class="pb-head">
                <span class="pb-title">📋 Profit Playbook</span>
                <span class="pb-meta">P&L ${pb.currentPnlPct >= 0 ? '+' : ''}${pb.currentPnlPct}% · ${pb.minsToClose > 0 ? pb.minsToClose+'m to close' : 'PAST CLOSE'}</span>
            </div>
            ${pb.rules.map(r => `
                <div class="pb-rule urgency-${r.urgency.toLowerCase()}">
                    <span class="pb-tag">${r.tag}</span>
                    <span class="pb-text">${r.text}</span>
                </div>
            `).join('')}
            <div class="pb-default">Default plan: ${pb.defaultPlan}</div>
        </div>
    `;
}

// ============================================================
//  S/R proximity — distance to nearest support / resistance
// ============================================================
function renderSRProximity(srLevels, spotNow, isCall) {
    if (!srLevels || !spotNow) return '';
    const sup = srLevels.support || [];
    const res = srLevels.resistance || [];
    if (!sup.length && !res.length) return '';
    const nearestS = sup.sort((a,b) => Math.abs(spotNow-a.price) - Math.abs(spotNow-b.price))[0];
    const nearestR = res.sort((a,b) => Math.abs(spotNow-a.price) - Math.abs(spotNow-b.price))[0];
    return `
        <div class="sr-prox">
            <span class="srp-title">📍 S/R Levels</span>
            ${nearestR ? `<span class="srp-item r">↥ R: <b>${nearestR.price.toFixed(2)}</b> (${(((nearestR.price-spotNow)/spotNow)*100).toFixed(2)}%)</span>` : ''}
            <span class="srp-spot">Spot ${spotNow.toFixed(2)}</span>
            ${nearestS ? `<span class="srp-item s">↧ S: <b>${nearestS.price.toFixed(2)}</b> (${(((spotNow-nearestS.price)/spotNow)*100).toFixed(2)}%)</span>` : ''}
        </div>
    `;
}

// ============================================================
//  AI Path Forecast — what the model thinks will happen next
//  Trained on 33k samples across 4 indices, 5yr 5m data.
// ============================================================
function renderForecastBlock(f) {
    if (!f) return '';
    const verdictClass = f.verdict === 'FAVORABLE' ? 'fav' : f.verdict === 'UNFAVORABLE' ? 'unfav' : f.verdict === 'CHOP' ? 'chop' : 'neutral';
    const verdictLabel = f.verdict === 'FAVORABLE' ? '✓ Favorable Path' : f.verdict === 'UNFAVORABLE' ? '⚠ Unfavorable Path' : f.verdict === 'CHOP' ? '↔ Chop Likely' : '· Neutral';
    const srcTag = f.source === 'trained' ? `<span class="forecast-src">AI · trained</span>` : `<span class="forecast-src heur">heuristic</span>`;
    return `
        <div class="forecast-block ${verdictClass}">
            <div class="forecast-head">
                <span class="forecast-title">🧠 AI Path Forecast (next ~${f.expectedDurationMin}m)</span>
                <span class="forecast-verdict ${verdictClass}">${verdictLabel}</span>
                ${srcTag}
            </div>
            <div class="forecast-prob-row">
                <div class="forecast-prob t1">
                    <div class="forecast-prob-label">P(Target Hit)</div>
                    <div class="forecast-prob-bar"><div style="width:${f.pT1}%"></div></div>
                    <div class="forecast-prob-val">${f.pT1.toFixed(0)}%</div>
                </div>
                <div class="forecast-prob sl">
                    <div class="forecast-prob-label">P(Stop-Loss Hit)</div>
                    <div class="forecast-prob-bar"><div style="width:${f.pSL}%"></div></div>
                    <div class="forecast-prob-val">${f.pSL.toFixed(0)}%</div>
                </div>
                <div class="forecast-prob to">
                    <div class="forecast-prob-label">P(Time-Out)</div>
                    <div class="forecast-prob-bar"><div style="width:${f.pTimeout}%"></div></div>
                    <div class="forecast-prob-val">${f.pTimeout.toFixed(0)}%</div>
                </div>
            </div>
            <div class="forecast-stats">
                <span>Expected favourable move: <b class="text-green">+${f.expectedMfePct.toFixed(2)}%</b></span>
                <span>Expected adverse move: <b class="text-red">-${f.expectedMaePct.toFixed(2)}%</b></span>
                <span>Model confidence: <b>${f.confidence}%</b></span>
            </div>
        </div>
    `;
}

// ============================================================
//  Active Trade Monitor — polls every 2s for realtime exit warnings
// ============================================================
async function refreshTradeMonitor() {
    const el = document.getElementById('trade-monitor');
    if (!el || !STATE.candles?.length) return;
    try {
        const r = await fetch(STATE.market.backend + '/api/active-trade/status', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candles: STATE.candles.slice(-220) })
        });
        const data = await r.json();
        if (!data.active) {
            el.innerHTML = '';
            STATE.activeTrade = null;
            STATE.trackedHits = {};
            return;
        }
        STATE.activeTrade = data.active;
        STATE.trackedHits = STATE.trackedHits || {};
        const sig = data.active;
        const m = data.monitor;
        STATE.lastMonitor = m;  // remember for exit-button payload
        const isCall = sig.side === 'BUY_CALL';
        const urgencyClass =
            m.urgency === 'EXIT_NOW' ? 'critical' :
            m.urgency === 'WARN'     ? 'warn' :
            m.urgency === 'ENDURE'   ? 'endure' :
            m.urgency === 'WATCH'    ? 'watch' : 'ok';
        const pnlClass = m.pnlEstimate >= 0 ? 'pos' : 'neg';

        // Detect SL_HIT / T1_HIT / T2_HIT in warnings
        const slHit = m.warnings?.some(w => w.tag === 'SL_HIT');
        const t1Hit = m.warnings?.some(w => w.tag === 'T1_HIT');

        // Distance-to-SL and Distance-to-T1 progress bars
        const entryPrem = sig.option.premium;
        const slPrem = sig.option.premiumSL;
        const t1Prem = sig.option.premiumT1;
        const t2Prem = sig.option.premiumT2;
        const curPrem = m.premEstimate;
        // Progress from entry to T1 (0% = entry, 100% = T1, negative = past SL)
        const upRange = t1Prem - entryPrem;
        const downRange = entryPrem - slPrem;
        let progress = 0;
        if (curPrem >= entryPrem) progress = ((curPrem - entryPrem) / upRange) * 100;
        else progress = -((entryPrem - curPrem) / downRange) * 100;
        const progressClamped = Math.max(-100, Math.min(110, progress));

        // ist time
        const enteredAt = new Date(sig.enteredAt || sig.time);
        const enteredAtIst = new Date(enteredAt.getTime() + (5*60+30)*60*1000);
        const enteredStr = String(enteredAtIst.getUTCHours()).padStart(2,'0') + ':' + String(enteredAtIst.getUTCMinutes()).padStart(2,'0');

        el.innerHTML = `
            <div class="monitor-card ${urgencyClass}">
                <div class="monitor-head">
                    <span class="monitor-urgency ${urgencyClass}">${m.urgency.replace('_', ' ')}</span>
                    <span class="monitor-time">${m.minutesInTrade}m in trade · entered ${enteredStr} IST</span>
                </div>
                ${m.urgencyMsg ? `<div class="monitor-urgency-msg ${urgencyClass}">${m.urgencyMsg}</div>` : ''}
                ${m.reasonsToHold?.length ? `
                    <div class="monitor-hold-block">
                        <div class="mhb-title">🤝 Reasons to HOLD</div>
                        ${m.reasonsToHold.map(r => `<div class="mhb-row">${r}</div>`).join('')}
                    </div>
                ` : ''}

                <!-- Trade detail card — always visible -->
                <div class="monitor-trade-detail ${isCall ? 'call' : 'put'}">
                    <div class="mtd-head">
                        <span class="mtd-side">${isCall ? 'BUY CALL' : 'BUY PUT'}</span>
                        <span class="mtd-strike">${sig.option.strike}<span class="mtd-right">${sig.option.right}</span></span>
                    </div>
                    <div class="mtd-grid">
                        <div class="mtd-cell"><span>Entry @</span><b>₹${entryPrem.toFixed(2)}</b></div>
                        <div class="mtd-cell"><span>Spot Entry</span><b>${sig.spot.entry}</b></div>
                        <div class="mtd-cell sl"><span>Stop Loss</span><b>₹${slPrem.toFixed(2)}</b></div>
                        <div class="mtd-cell tp"><span>Target 1</span><b>₹${t1Prem.toFixed(2)}</b></div>
                        <div class="mtd-cell tp2"><span>Target 2</span><b>₹${t2Prem.toFixed(2)}</b></div>
                        <div class="mtd-cell"><span>Lots × Qty</span><b>${sig.sizing.lots} × ${sig.option.lotSize}</b></div>
                        <div class="mtd-cell"><span>Quantity</span><b>${sig.sizing.quantity}</b></div>
                        <div class="mtd-cell"><span>Max Loss</span><b class="text-red">${fmtCurrency(sig.sizing.maxLoss)}</b></div>
                    </div>
                    <div class="mtd-progress">
                        <div class="mtd-progress-track">
                            <div class="mtd-progress-zero"></div>
                            <div class="mtd-progress-fill ${progressClamped >= 0 ? 'pos' : 'neg'}" style="width:${Math.min(100, Math.abs(progressClamped))}%; ${progressClamped >= 0 ? 'left:50%;' : 'right:50%;'}"></div>
                        </div>
                        <div class="mtd-progress-labels">
                            <span class="mtd-pl-sl">SL ₹${slPrem.toFixed(2)}</span>
                            <span class="mtd-pl-mid">Entry ₹${entryPrem.toFixed(2)}</span>
                            <span class="mtd-pl-t1">T1 ₹${t1Prem.toFixed(2)}</span>
                        </div>
                    </div>
                </div>

                <!-- Live P&L row -->
                <div class="monitor-pnl">
                    <div class="monitor-pnl-block">
                        <span>Current Premium</span>
                        <b>₹${m.premEstimate.toFixed(2)}</b>
                    </div>
                    <div class="monitor-pnl-block">
                        <span>Current Spot</span>
                        <b>${m.spotNow.toFixed(2)}</b>
                    </div>
                    <div class="monitor-pnl-block">
                        <span>Live P&L</span>
                        <b class="monitor-pnl-val ${pnlClass}">${m.pnlEstimate >= 0 ? '+' : ''}${fmtCurrency(m.pnlEstimate)}</b>
                    </div>
                </div>

                ${data.forecast ? renderForecastBlock(data.forecast) : ''}

                ${renderGammaBlastBanner(data.gammaBlast)}
                ${renderGreeksPill(data.greeks, data.gammaBlast)}
                ${renderPlaybookBlock(data.playbook)}
                ${renderSRProximity(data.srLevels, m.spotNow, isCall)}

                ${slHit ? `
                    <div class="monitor-special-alert sl-alert">
                        🛑 STOP LOSS HIT — close the position NOW
                    </div>
                ` : ''}
                ${t1Hit && !slHit ? `
                    <div class="monitor-special-alert t1-alert">
                        🎯 TARGET 1 HIT — book 50%, trail rest
                    </div>
                ` : ''}

                ${m.warnings?.length ? `
                    <div class="monitor-warnings">
                        <div class="mw-title">${m.reversalEvidence >= 3 ? '⛔ Confluence reversal — exit is correct' : m.reversalEvidence >= 2 ? '⚠ ' + m.reversalEvidence + ' reversal signals · need 3rd for exit' : 'ⓘ ' + m.warnings.length + ' note' + (m.warnings.length>1?'s':'') + ' · no exit needed'}</div>
                        ${m.warnings.map(w => `<div class="monitor-warn sev-${w.severity >= 90 ? 'hard' : w.severity >= 40 ? 'mid' : 'soft'}"><span class="monitor-tag">${w.tag.replace(/_/g, ' ')}</span><span class="monitor-msg">${w.msg}</span></div>`).join('')}
                    </div>
                ` : '<div style="font-size:10px;color:var(--text-3);padding:6px">No concerns — trade looks healthy</div>'}

                <button class="monitor-exit" onclick="window.exitActiveTrade('manual')">CLOSE TRADE</button>
            </div>
        `;

        // ============ GAMMA BLAST ALERT — fires once when severity crosses 70 ============
        if (data.gammaBlast?.severity >= 70 && !STATE.trackedHits.gammaBlast) {
            STATE.trackedHits.gammaBlast = true;
            playTargetAlert();  // celebratory chime
            toast(`🚀 GAMMA BLAST IMMINENT — severity ${data.gammaBlast.severity}. Hold core, lift stops.`, 'success');
            addLog('SIGNAL', `Gamma blast on ${sig.option.strike}${sig.option.right} — Γ=${data.gammaBlast.gamma}`);
        }
        // Reset when severity drops
        if (data.gammaBlast?.severity < 50) STATE.trackedHits.gammaBlast = false;

        // ============ SOUND ALERTS — fire ONCE per event ============
        // SL_HIT (loss)
        if (slHit && !STATE.trackedHits.slHit) {
            STATE.trackedHits.slHit = true;
            playExitAlert();
            toast('🛑 STOP LOSS HIT — close the position NOW', 'error');
            addLog('WARN', `SL hit on ${sig.option.strike} ${sig.option.right} @ ₹${slPrem.toFixed(2)}`);
        }
        // T1_HIT (target reached — celebration)
        if (t1Hit && !STATE.trackedHits.t1Hit) {
            STATE.trackedHits.t1Hit = true;
            playTargetAlert();
            toast('🎯 TARGET 1 HIT — book 50%!', 'success');
            addLog('SIGNAL', `Target 1 hit on ${sig.option.strike} ${sig.option.right} @ ₹${t1Prem.toFixed(2)}`);
        }
        // Generic EXIT NOW — fires ONLY on real reversal or time stop,
        // not on noise. Drawdown alone never triggers this.
        const hardExit = m.urgency === 'EXIT_NOW' &&
                         (m.exitReason === 'TIME_STOP' || m.exitReason === 'CONFLUENCE_REVERSAL');
        if (hardExit && !slHit && !STATE.lastExitAlert) {
            STATE.lastExitAlert = Date.now();
            playExitAlert();
            const reasonTxt = m.exitReason === 'TIME_STOP' ? 'Past 15:15 IST' :
                              `${m.reversalEvidence} reversal signals confirmed (${(m.reversalSignals||[]).join(', ')})`;
            toast('🚨 EXIT NOW — ' + reasonTxt, 'error');
            addLog('WARN', 'EXIT NOW: ' + reasonTxt);
        }
        if (m.urgency !== 'EXIT_NOW') STATE.lastExitAlert = null;
    } catch (e) {
        // Silent
    }
}

// Pleasant 3-note rising chime for target hit (celebration)
function playTargetAlert() {
    playTone({ frequency: 660, duration: 130, volume: 0.20 });
    setTimeout(() => playTone({ frequency: 880, duration: 130, volume: 0.20 }), 130);
    setTimeout(() => playTone({ frequency: 1175, duration: 280, volume: 0.22 }), 260);
}

setInterval(refreshTradeMonitor, 2000);  // real-time monitoring

// ============================================================
//  NOTIFICATION SOUNDS — Web Audio API
// ============================================================
let audioCtx = null;
function getAudio() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) { return null; }
    }
    return audioCtx;
}

function playTone({ frequency = 880, duration = 220, type = 'sine', volume = 0.18 } = {}) {
    const ctx = getAudio();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration / 1000);
    } catch (_) {}
}

// Pleasant 2-note signal chime
function playSignalAlert() {
    playTone({ frequency: 880, duration: 130 });
    setTimeout(() => playTone({ frequency: 1175, duration: 180 }), 130);
}

// Urgent 3-note descending exit alert
function playExitAlert() {
    playTone({ frequency: 880, duration: 150, type: 'square', volume: 0.22 });
    setTimeout(() => playTone({ frequency: 700, duration: 150, type: 'square', volume: 0.22 }), 160);
    setTimeout(() => playTone({ frequency: 550, duration: 280, type: 'square', volume: 0.25 }), 320);
}

// Unlock audio on any user interaction (browser policy)
document.addEventListener('click', () => { getAudio(); }, { once: true });

// ============================================================
//  Multi-Timeframe Scanner — runs every 20s
// ============================================================
STATE.lastMultiTfSeenSignals = new Set();   // track which TF/side combos we've sounded for

async function refreshMultiTf() {
    const grid = document.getElementById('multitf-grid');
    const agg = document.getElementById('multitf-agg');
    if (!grid) return;
    try {
        const r = await fetch(STATE.market.backend + `/api/signals/multi-tf/${STATE.selectedSymbol}?riskPercent=${cfg.risk}&accountSize=${cfg.capital}&minScore=${cfg.minAiScore ?? 0}`);
        if (!r.ok) throw new Error('multi-tf fetch failed');
        const data = await r.json();

        // Aggregate chip
        if (agg) {
            const a = data.aggregate;
            const txt =
                a === 'BUY_CALL'   ? 'CALL · ' + data.firingTfs.call.length + ' TFs' :
                a === 'BUY_PUT'    ? 'PUT · '  + data.firingTfs.put.length  + ' TFs' :
                a === 'WATCH_CALL' ? 'WATCH CALL (1 TF)' :
                a === 'WATCH_PUT'  ? 'WATCH PUT (1 TF)'  :
                'no signal across TFs';
            agg.textContent = txt;
            agg.className = 'multitf-agg ' + (a === 'BUY_CALL' ? 'call' : a === 'BUY_PUT' ? 'put' : a.startsWith('WATCH') ? 'watch' : '');
        }

        // Grid cells
        const labelMap = { '1minute':'1m','3minute':'3m','5minute':'5m','15minute':'15m','30minute':'30m','60minute':'1H','1day':'1D' };
        grid.innerHTML = data.tfs.map(t => {
            const fired = t.side === 'BUY_CALL' || t.side === 'BUY_PUT';
            const sideCls = t.side === 'BUY_CALL' ? 'call' : t.side === 'BUY_PUT' ? 'put' : t.side === 'NO_DATA' ? 'nodata' : '';
            const sideLbl = t.side === 'BUY_CALL' ? 'CE' : t.side === 'BUY_PUT' ? 'PE' : t.side === 'NO_DATA' ? 'n/d' : '—';
            const conf = (t.confluenceScore || 0) + '%';
            // AI Path Forecast mini-badge: shows pT1 when actionable
            let forecastBadge = '';
            if (t.forecast) {
                const f = t.forecast;
                const vClass = f.verdict === 'FAVORABLE' ? 'fav' : f.verdict === 'UNFAVORABLE' ? 'unfav' : f.verdict === 'CHOP' ? 'chop' : 'neutral';
                forecastBadge = `<div class="multitf-forecast ${vClass}" title="AI Forecast — P(T1)=${f.pT1}% · P(SL)=${f.pSL}% · ${f.verdict}">🧠 ${f.pT1.toFixed(0)}%</div>`;
            }
            return `<div class="multitf-cell ${sideCls}" data-tf="${t.tf}" title="${t.firingNames?.join(', ') || ''}">
                ${fired ? '<span class="multitf-fired"></span>' : ''}
                <div class="multitf-tf">${labelMap[t.tf] || t.tf}</div>
                <div class="multitf-side">${sideLbl}</div>
                <div class="multitf-conf">${conf}</div>
                ${forecastBadge}
            </div>`;
        }).join('');

        // Click cell → switch chart to that TF
        grid.querySelectorAll('.multitf-cell').forEach(cell => {
            cell.addEventListener('click', () => {
                const tf = cell.dataset.tf;
                if (!tf) return;
                const tab = document.querySelector(`.tf-tab[data-tf="${tf}"]`);
                if (tab) tab.click();
            });
        });

        // SOUND ALERTS — new firings ring once
        const firingNow = data.tfs.filter(t => t.side === 'BUY_CALL' || t.side === 'BUY_PUT');
        for (const t of firingNow) {
            const key = t.tf + ':' + t.side;
            if (!STATE.lastMultiTfSeenSignals.has(key)) {
                STATE.lastMultiTfSeenSignals.add(key);
                playSignalAlert();
                toast(`🔔 ${t.side === 'BUY_CALL' ? 'BUY CALL' : 'BUY PUT'} signal on ${labelMap[t.tf]}  · ${t.confluenceScore}% confluence`, 'success');
                addLog('SIGNAL', `${t.tf}: ${t.side} (${t.confluenceScore}%)`);
            }
        }
        // Drop stale (no longer firing) keys
        const currentKeys = new Set(firingNow.map(t => t.tf + ':' + t.side));
        for (const k of STATE.lastMultiTfSeenSignals) {
            if (!currentKeys.has(k)) STATE.lastMultiTfSeenSignals.delete(k);
        }
    } catch (e) {
        if (grid) grid.innerHTML = `<div class="multitf-empty">Error: ${e.message}</div>`;
    }
}

setTimeout(refreshMultiTf, 1500);
setInterval(refreshMultiTf, 2000);  // 2s realtime — server cache makes this cheap

function renderPossibleSignals(possibles) {
    const list = document.getElementById('possible-list');
    if (!list) return;
    const ranked = possibles.filter(p => p.proximity > 30).slice(0, 4);
    if (ranked.length === 0) {
        list.innerHTML = '<div class="possible-empty">No setups close to firing right now.</div>';
        return;
    }
    list.innerHTML = ranked.map(p => {
        const side = p.side === 'BUY_CALL' ? 'call' : p.side === 'BUY_PUT' ? 'put' : null;
        const sideLabel = p.side === 'BUY_CALL' ? 'CE' : p.side === 'BUY_PUT' ? 'PE' : '';
        const proxClass = p.proximity >= 60 ? 'high' : p.proximity >= 45 ? 'medium' : 'low';
        // Hide the side badge entirely when direction isn't committed yet.
        // The empty "—" was being read as a collapse toggle by users.
        const sideBadge = side
            ? `<span class="possible-side ${side}">${sideLabel}</span>`
            : '';
        return `<div class="possible-row ${proxClass} ${side || 'no-side'}">
            ${sideBadge}
            <div class="possible-body">
                <span class="possible-name">${p.name}</span>
                <span class="possible-needs">${p.needs}</span>
            </div>
            <span class="possible-prox ${p.proximity >= 60 ? 'high' : ''}">${p.proximity}%</span>
        </div>`;
    }).join('');
}

// Initial fetch + refresh every 20s
setTimeout(refreshAIRationale, 2500);
setInterval(refreshAIRationale, 20 * 1000);

// ============================================================
//  This Week's Trade History
// ============================================================
async function refreshHistory() {
    const listEl = document.getElementById('history-list');
    if (!listEl) return;
    try {
        const r = await fetch(STATE.market.backend + '/api/history/week');
        if (!r.ok) throw new Error('fetch failed');
        const data = await r.json();
        const s = data.summary;

        // Header label: "Week of May 25"
        const weekDate = s.weekKey ? new Date(s.weekKey + 'T00:00:00Z') : null;
        const labelEl = document.getElementById('history-week-label');
        if (labelEl && weekDate) {
            labelEl.textContent = 'Week of ' + weekDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        }

        // Stats
        document.getElementById('hist-count').textContent = s.tradeCount || 0;
        document.getElementById('hist-wr').textContent = s.tradeCount ? s.winRate.toFixed(0) + '%' : '—';
        const pnlEl = document.getElementById('hist-pnl');
        pnlEl.textContent = s.netPnL ? fmtCurrency(s.netPnL) : '₹0';
        pnlEl.className = (s.netPnL > 0 ? 'up' : s.netPnL < 0 ? 'dn' : '');
        const pfEl = document.getElementById('hist-pf');
        pfEl.textContent = s.tradeCount ? (s.profitFactor === 0 ? '0' : s.profitFactor.toFixed(2)) : '—';
        pfEl.className = (s.profitFactor >= 1 ? 'up' : s.profitFactor > 0 ? 'dn' : '');

        // Trade list
        const trades = data.trades || [];
        if (trades.length === 0) {
            listEl.innerHTML = '<div class="history-empty">No trades yet this week.</div>';
            return;
        }
        listEl.innerHTML = trades.map(t => {
            const d = new Date(t.time);
            const time = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
                d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
            const side = t.side === 'BUY_CALL' ? 'call' : 'put';
            const win = t.pnl > 0;
            const pnlSign = win ? '+' : '';
            const reason = (t.exitReason || '').replace('_', ' ');
            return `<div class="hist-row" title="${t.regime || ''} | conf ${t.confidence}% ${t.tier}">
                <div>
                    <div class="hr-time">${time}</div>
                </div>
                <div>
                    <span class="hr-strike ${side}">${t.strike}${t.right}</span>
                    <span class="hr-reason">${reason}</span>
                </div>
                <span class="hr-pnl ${win ? 'up' : 'dn'}">${pnlSign}${fmtCurrency(t.pnl)}</span>
                <span class="hr-result ${win ? 'win' : 'loss'}">${t.result}</span>
            </div>`;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="history-empty">Error: ${e.message}</div>`;
    }
}

// Initial fetch + refresh every 15 seconds
setTimeout(refreshHistory, 1800);
setInterval(refreshHistory, 15000);

// ============================================================
//  Chart overlays — S/R levels (multi-TF) + OI walls
// ============================================================
STATE.overlayLines = [];

function clearOverlayLines() {
    if (!STATE.candleSeries) return;
    STATE.overlayLines.forEach(l => { try { STATE.candleSeries.removePriceLine(l); } catch (_) {} });
    STATE.overlayLines = [];
}

async function refreshChartOverlays() {
    if (!STATE.candleSeries) return;
    const sym = STATE.selectedSymbol;
    try {
        const [srResp, oiResp] = await Promise.all([
            fetch(STATE.market.backend + `/api/levels/sr/${sym}`).then(r => r.json()),
            fetch(STATE.market.backend + `/api/levels/oi-walls/${sym}`).then(r => r.json())
        ]);

        clearOverlayLines();

        // TF color map for S/R (light blue → deep blue for higher TFs)
        const tfStyle = {
            '5minute':  { color: 'rgba(100,180,255,0.45)', width: 1, style: 1, label: '5m' },
            '15minute': { color: 'rgba(60,140,240,0.55)',  width: 1, style: 1, label: '15m' },
            '60minute': { color: 'rgba(30,100,220,0.65)',  width: 2, style: 0, label: '1H' },
            '1day':     { color: 'rgba(255,80,80,0.75)',   width: 2, style: 0, label: '1D' }
        };

        for (const [tf, data] of Object.entries(srResp)) {
            const style = tfStyle[tf];
            if (!style || !data.supports) continue;
            for (const s of data.supports) {
                const l = STATE.candleSeries.createPriceLine({
                    price: s.price,
                    color: style.color, lineWidth: style.width, lineStyle: style.style,
                    axisLabelVisible: true,
                    title: `S ${style.label}${s.touches > 1 ? '×' + s.touches : ''}`
                });
                STATE.overlayLines.push(l);
            }
            for (const r of data.resistances) {
                const l = STATE.candleSeries.createPriceLine({
                    price: r.price,
                    color: style.color, lineWidth: style.width, lineStyle: style.style,
                    axisLabelVisible: true,
                    title: `R ${style.label}${r.touches > 1 ? '×' + r.touches : ''}`
                });
                STATE.overlayLines.push(l);
            }
        }

        // OI walls — distinct strong colors
        if (oiResp.resistance) {
            for (const w of oiResp.resistance) {
                const l = STATE.candleSeries.createPriceLine({
                    price: w.strike,
                    color: 'rgba(255,45,125,0.85)',  // magenta = call wall (resistance)
                    lineWidth: 2, lineStyle: 2,  // dashed
                    axisLabelVisible: true,
                    title: `CE ${w.strike} · ${(w.oi/100000).toFixed(1)}L`
                });
                STATE.overlayLines.push(l);
            }
        }
        if (oiResp.support) {
            for (const w of oiResp.support) {
                const l = STATE.candleSeries.createPriceLine({
                    price: w.strike,
                    color: 'rgba(0,255,148,0.85)',  // green = put wall (support)
                    lineWidth: 2, lineStyle: 2,
                    axisLabelVisible: true,
                    title: `PE ${w.strike} · ${(w.oi/100000).toFixed(1)}L`
                });
                STATE.overlayLines.push(l);
            }
        }
        if (oiResp.maxPain) {
            const l = STATE.candleSeries.createPriceLine({
                price: oiResp.maxPain,
                color: 'rgba(255,179,0,0.75)',
                lineWidth: 1, lineStyle: 3,
                axisLabelVisible: true,
                title: `Max Pain ${oiResp.maxPain}`
            });
            STATE.overlayLines.push(l);
        }
    } catch (e) {
        addLog('WARN', 'Chart overlay refresh failed: ' + e.message);
    }
}

setTimeout(refreshChartOverlays, 3500);
setInterval(refreshChartOverlays, 60 * 1000);  // refresh every minute

// Wire reset button
document.addEventListener('DOMContentLoaded', () => {
    const resetBtn = document.getElementById('history-reset');
    if (resetBtn) resetBtn.onclick = async () => {
        if (!confirm('Clear ALL trades for this week? (Already archived to data/archive/)')) return;
        try {
            await fetch(STATE.market.backend + '/api/history/week', { method: 'DELETE' });
            refreshHistory();
            toast('Week history cleared', 'success');
        } catch (e) {
            toast('Reset failed: ' + e.message, 'error');
        }
    };
});

// ============================================================
//  Helpers
// ============================================================
function fmtPrice(p) {
    if (p == null || isNaN(p)) return '--';
    return Number(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(p) {
    if (p == null || isNaN(p)) return '0.00%';
    return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
}
function fmtVol(v) {
    if (v == null) return '0';
    const abs = Math.abs(v);
    if (abs >= 10000000) return (v / 10000000).toFixed(1) + 'Cr';
    if (abs >= 100000) return (v / 100000).toFixed(1) + 'L';
    if (abs >= 1000) return (v / 1000).toFixed(1) + 'K';
    return Math.round(v).toString();
}
function fmtCurrency(v) {
    if (v == null) return '₹0';
    return (v < 0 ? '-' : '') + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');
}

function addLog(tag, msg) {
    STATE.logs.unshift({ time: Date.now(), tag, msg });
    if (STATE.logs.length > 60) STATE.logs.pop();
    const el = document.getElementById('system-logs');
    if (!el) return;
    el.innerHTML = STATE.logs.map(l => {
        const t = new Date(l.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `<div class="log-line"><span class="log-time">${t}</span><span class="log-tag ${l.tag}">${l.tag}</span><span class="log-msg">${l.msg}</span></div>`;
    }).join('');
}

function toast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.classList.add('fade'), 3000);
    setTimeout(() => t.remove(), 3500);
}
