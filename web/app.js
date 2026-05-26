// app.js — QuantEdge Options Terminal entry point

const SETTINGS = JSON.parse(localStorage.getItem('qe2_settings') || '{}');
const cfg = {
    backend: SETTINGS.backend || 'http://localhost:4300',
    capital: SETTINGS.capital || 500000,
    risk: SETTINGS.risk || 2,
    maxTrades: SETTINGS.maxTrades || 5
};

const SYMBOLS = ['NIFTY', 'SENSEX', 'FINNIFTY'];
const SYMBOL_NAMES = { NIFTY: 'NIFTY 50', SENSEX: 'SENSEX', FINNIFTY: 'FINNIFTY' };

const STATE = {
    selectedSymbol: 'NIFTY',
    selectedTF: '5minute',
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
});

// ============================================================
//  Topbar / sidebar wiring
// ============================================================
function setupTopbar() {
    document.getElementById('settings-btn').onclick = () => {
        document.getElementById('settings-modal').style.display = 'flex';
    };
}

function setupSidebar() {
    document.querySelectorAll('#symbol-tabs .sym-tab').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('#symbol-tabs .sym-tab').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            STATE.selectedSymbol = b.dataset.symbol;
            loadHistory();
            loadOptionChain();
            renderMainHead();
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
    document.getElementById('acct-risk').addEventListener('change', (e) => {
        cfg.risk = parseFloat(e.target.value);
        saveSettings();
        updateSidebarAccount();
        if (STATE.activeSignal) renderSignalCard(STATE.activeSignal);
    });
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
    document.getElementById('settings-close').onclick = () => modal.style.display = 'none';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('set-capital').value = cfg.capital;
    document.getElementById('set-risk').value = cfg.risk;
    document.getElementById('set-max-trades').value = cfg.maxTrades;
    document.getElementById('set-backend').value = cfg.backend;
    document.getElementById('set-save').onclick = () => {
        cfg.capital = parseFloat(document.getElementById('set-capital').value) || cfg.capital;
        cfg.risk = parseFloat(document.getElementById('set-risk').value) || cfg.risk;
        cfg.maxTrades = parseInt(document.getElementById('set-max-trades').value) || cfg.maxTrades;
        const newBackend = document.getElementById('set-backend').value.trim() || cfg.backend;
        if (newBackend !== cfg.backend) {
            cfg.backend = newBackend;
            STATE.market.setBackend(cfg.backend);
            STATE.market.connectWS();
        }
        saveSettings();
        updateSidebarAccount();
        modal.style.display = 'none';
        toast('Settings saved', 'success');
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
    STATE.chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: { background: { type: 'solid', color: '#07070F' }, textColor: '#7878A0', fontSize: 11, fontFamily: 'Inter' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.025)' }, horzLines: { color: 'rgba(255,255,255,0.025)' } },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,208,156,0.35)', width: 1, style: 2, labelBackgroundColor: '#00D09C' },
            horzLine: { color: 'rgba(0,208,156,0.35)', width: 1, style: 2, labelBackgroundColor: '#00D09C' }
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.05)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.05)', timeVisible: true, secondsVisible: false }
    });

    STATE.candleSeries = STATE.chart.addCandlestickSeries({
        upColor: '#00D09C', downColor: '#EB5B3C',
        borderUpColor: '#00D09C', borderDownColor: '#EB5B3C',
        wickUpColor: '#00D09C', wickDownColor: '#EB5B3C'
    });
    STATE.volumeSeries = STATE.chart.addHistogramSeries({
        color: 'rgba(0,208,156,0.35)', priceFormat: { type: 'volume' },
        priceScaleId: '', scaleMargins: { top: 0.86, bottom: 0 }
    });
    STATE.ema9Series = STATE.chart.addLineSeries({ color: '#3B82F6', lineWidth: 2, title: 'EMA 9' });
    STATE.ema21Series = STATE.chart.addLineSeries({ color: '#8B5CF6', lineWidth: 2, title: 'EMA 21' });
    STATE.vwapSeries = STATE.chart.addLineSeries({ color: '#F0B90B', lineWidth: 2, lineStyle: 2, title: 'VWAP' });
    STATE.bbUpper = STATE.chart.addLineSeries({ color: 'rgba(6,182,212,0.6)', lineWidth: 1, title: 'BB Upper', visible: false });
    STATE.bbLower = STATE.chart.addLineSeries({ color: 'rgba(6,182,212,0.6)', lineWidth: 1, title: 'BB Lower', visible: false });

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
    } catch (e) {
        addLog('ERROR', `History load failed: ${e.message}`);
    }
}

async function loadOptionChain() {
    try {
        const chain = await STATE.market.getOptionChain(STATE.selectedSymbol);
        STATE.chain = chain;
        // pick nearest expiry
        const expiries = [...new Set(chain.map(c => c.expiry).filter(Boolean))].sort();
        STATE.chainExpiry = expiries[0] || null;
        renderChainExpiry(expiries);
        renderOptionChain();
    } catch (e) {
        addLog('ERROR', `Chain load failed: ${e.message}`);
    }
}

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
        document.getElementById('main-price').textContent = fmtPrice(tick.price);
        const ch = document.getElementById('main-change');
        ch.textContent = fmtPct(tick.changePercent);
        ch.className = 'main-change ' + (tick.change >= 0 ? 'up' : 'dn');

        // update last candle live
        if (STATE.candles.length) {
            const last = STATE.candles[STATE.candles.length - 1];
            last.close = tick.price;
            if (tick.price > last.high) last.high = tick.price;
            if (tick.price < last.low) last.low = tick.price;
            if (STATE.candleSeries) {
                STATE.candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
            }
        }
    }
}

// Periodic candle append + signal check
setInterval(async () => {
    if (!STATE.candles.length) return;
    // Refresh history every minute to pick up new candle from backend
    try {
        const candles = await STATE.market.getHistorical(STATE.selectedSymbol, STATE.selectedTF, 200);
        if (candles.length && candles[candles.length - 1].time !== STATE.candles[STATE.candles.length - 1].time) {
            STATE.candles = candles;
            STATE.candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
            STATE.volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(0,208,156,0.4)' : 'rgba(235,91,60,0.4)' })));
            updateChartIndicators();
        }
    } catch (e) {}
    triggerSignalCheck();
}, 30000);

// Trigger signal check every 15s using current state
setInterval(triggerSignalCheck, 15000);

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
    document.getElementById('acct-risk').value = String(cfg.risk);
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
