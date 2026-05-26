# QuantEdge — Options Terminal (v2)

A Bloomberg-style intraday options trading assistant for **NIFTY** and **SENSEX**, focused on options buying. Real-time data via **ICICI Direct Breeze Connect**. Every signal includes detailed execution: exact strike, premium-based stop loss & targets, lot sizing, max loss, time stop, and an 8-point reasoning checklist.

## Honest claims

- **Not** a 90% accuracy system. No public retail system is. Anyone selling that to you is lying.
- Realistic target: **55–62% win rate at 1:2 R:R**, which is profitable over 50+ trades.
- This is a **decision-support tool**, not an auto-trader. You place every order manually with your broker.
- Mock-data mode is included so you can develop & demo without live credentials.

---

## Architecture

```
quantedge-v2/
├── server/                 Node.js backend (Express + WebSocket)
│   ├── index.js            REST + WS relay
│   ├── breeze.js           Breeze Connect adapter (+ mock fallback)
│   ├── signal.js           Options signal engine (8 conditions, strike picker, sizing)
│   ├── package.json
│   └── .env.example        Copy to .env and fill credentials
└── web/                    Frontend (static HTML/CSS/JS)
    ├── index.html          3-column fixed layout
    ├── styles.css          Modern dark theme
    ├── market.js           REST + WS client
    └── app.js              UI + chart + signal rendering
```

---

## Quick start (mock mode — no credentials needed)

```powershell
# 1. Install backend dependencies
cd quantedge-v2/server
npm install

# 2. Create .env from the example
copy .env.example .env

# 3. Start backend (mock mode by default)
npm start

# 4. In a new terminal, serve the frontend
cd quantedge-v2/web
npx --yes http-server . -p 5181 -c-1

# 5. Open http://localhost:5181
```

You'll see the terminal with simulated NIFTY/SENSEX/FINNIFTY data and signals firing every 15-60 seconds. The status pill in the topbar says **"Mock data"**.

---

## Enabling real-time Breeze data (ICICI Direct)

You need an active **ICICI Direct demat account**. The Breeze API is free.

### Step 1 — Register a Breeze app

1. Go to https://api.icicidirect.com/apiuser/home and sign in with your ICICI Direct credentials.
2. Click **Register an App** and fill in:
   - App name: anything (e.g. `quantedge-local`)
   - Redirect URL: `http://localhost:4300/api/breeze-callback`
3. You'll get an **API Key** and **API Secret**. Save these securely.

### Step 2 — Generate a daily session token

Breeze session tokens **expire every day at midnight IST** and must be regenerated.

1. Open this URL in your browser, replacing `<API_KEY>`:
   ```
   https://api.icicidirect.com/apiuser/login?api_key=<URL_ENCODED_API_KEY>
   ```
   (URL-encode the API key: e.g. `+` becomes `%2B`)
2. Log in with your ICICI Direct credentials and 2FA.
3. After login the browser redirects to your callback URL with `?apisession=<TOKEN>` as a query parameter.
4. Copy the token.

### Step 3 — Fill `.env`

```bash
BREEZE_API_KEY=your_api_key_here
BREEZE_API_SECRET=your_api_secret_here
BREEZE_SESSION_TOKEN=todays_session_token_here

PORT=4300
WEB_ORIGIN=http://localhost:5181
USE_MOCK=false
```

### Step 4 — Restart backend

```powershell
cd quantedge-v2/server
npm start
```

You should see `mode: live` in the console. The topbar pill in the web app turns green and reads **"Live"**.

### Daily routine

Every morning before market open:
1. Re-run Step 2 to get a fresh session token
2. Update `BREEZE_SESSION_TOKEN` in `.env`
3. Restart the backend

> **Why daily?** Breeze's session model. We could automate this with Playwright headless login but it would store your password — not recommended.

---

## What the UI shows

### Topbar
- **Live ticker strip**: NIFTY, SENSEX, FINNIFTY price + % change (flashes green/red on tick)
- **Connection status**: live / mock / error
- **IST clock**

### Left sidebar
- Symbol selector (NIFTY / SENSEX / FINNIFTY)
- Timeframe (1m / 5m / 30m / 1D)
- Market pulse (VIX, PCR, Adv/Dec, FII flow)
- Account state (capital, risk %, today's P&L, trades left)
- Live system log

### Main panel (center)
- Candlestick chart with EMA 9/21, VWAP, Bollinger Bands (toggleable)
- Buy/sell markers when a signal fires
- Horizontal price lines for entry, SL, T1, T2
- Floating popup on the chart with strike + premium when a signal fires

### Options Chain
- 13 strikes centered on ATM with **OI bars** (red = call OI, green = put OI)
- OI Change column (green up, red down — useful for spotting fresh writing/unwinding)
- IV and LTP for both CE and PE
- Selected signal's strike row is highlighted
- Footer: PCR, ATM strike

### Right signal panel — **the important part**

When a signal fires, you see:

1. **Header**: BUY CALL / BUY PUT badge + tier (HIGH/MED/LOW) + confidence %
2. **Strike block**: exact strike + right (CE/PE), entry premium, IV, delta assumed, rationale ("ATM for best delta/theta balance" or "ITM by 1 strike for intrinsic cushion")
3. **Levels**:
   - SL Premium (₹X) — with corresponding spot SL
   - Target 1 (₹X) — with spot T1
   - Target 2 (₹X) — with spot T2
   - Risk:Reward + Time stop (e.g. exit by 3:15 PM regardless)
4. **Sizing**:
   - Lots (auto-calculated from your risk %)
   - Quantity
   - Capital required
   - Max loss (₹)
   - Risk on account (% of capital)
5. **8-point reasoning checklist** — every factor with ✓ or ✗
6. **Trade checklist** — numbered execution steps you can follow

### Recent signals
Last 8 signals with quick-glance confidence pills.

---

## How the signal engine works

Each candle close, the engine scores 8 conditions:

| # | Condition | Max pts |
|---|-----------|---------|
| 1 | Trend Alignment (EMA9/21 + VWAP side) | 20 |
| 2 | VWAP Distance (not too far, not too close) | 15 |
| 3 | RSI Momentum (50-72 for calls, 28-50 for puts) | 10 |
| 4 | Volume Confirmation (>1.3× 20-period avg) | 15 |
| 5 | Structure (S/R breakout) | 15 |
| 6 | Volatility Filter (ATR 0.08–0.45% of price) | 10 |
| 7 | Option Flow (PCR alignment with bias) | 10 |
| 8 | IV Context (11–22% — tradeable range) | 5 |

**Total: 100 points → confidence %.**

- ≥72 = **HIGH** tier (take it)
- 55–71 = **MEDIUM** (consider with smaller size)
- <55 = **LOW** / no trade

### Strike selection rules

- **HIGH confidence**: prefer 1 strike ITM (intrinsic value cushion → premium falls less if you're wrong)
- **MEDIUM/LOW confidence**: ATM (best delta/theta balance)
- **Low IV environment**: shift 1 OTM for leverage
- Always filter by **OI > 1,00,000** for liquidity (tight bid-ask)

### Position sizing

```
maxRisk      = accountSize × (risk% / 100)
riskPerLot   = (entryPremium − slPremium) × lotSize
lots         = floor(maxRisk / riskPerLot)
maxLoss      = lots × lotSize × (entryPremium − slPremium)
```

For NIFTY (lot 25) at ₹128 premium, ₹95 SL, 2% risk on ₹5L → 3 lots = 75 qty, max loss ₹2,475.

### Why "90% accuracy" isn't realistic

- Top quant funds with PhDs and ₹100Cr infrastructure rarely exceed **55–60%** win rate on intraday.
- Options buying is harder than futures because **theta decay** punishes you even when you're directionally right but slow.
- A 60% win rate at 1:2 R:R = `0.6×2 − 0.4×1 = +0.8` expectancy per trade. That's a phenomenal edge. Compounded over 50 trades, you double your capital.
- A "90% win rate" usually means tight targets + wide stops (1:0.3 R:R), which loses money over time because the 10% losses wipe out 30 wins.

**Focus on R:R and discipline, not win rate.**

---

## Risk management built in

- **Daily trade limit** (default 5/day) — prevents revenge trading
- **Cooldown after 2 consecutive losses** (15 min) — forces a break
- **Daily loss limit** (3% of capital) — auto-halts trading for the day
- **Time stop** at 15:15 IST — always exits before EOD theta crush
- **Position sizing** capped at your risk % — never blow up on one trade

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Frontend shows "Backend offline" | Backend not running. `cd server && npm start` |
| Topbar says "Mock data" but you want live | Check `.env` has all 3 Breeze fields filled and `USE_MOCK=false`. Restart server. |
| Breeze 401 / "Session expired" | Regenerate session token (Step 2 of setup). Daily routine. |
| Option chain empty | The expiry might be wrong. Try near monthly first. SENSEX uses `BFO`, NIFTY uses `NFO` exchange. |
| Chart not rendering | Hard refresh (Ctrl+Shift+R). Check browser console for CSP errors blocking the lightweight-charts CDN. |
| Signals never fire | Confidence threshold is 55%. In low-volatility periods this is intentional — quality over quantity. Lower the threshold in `server/signal.js` if you want more signals. |

---

## Roadmap (not built yet)

- [ ] Breeze WebSocket streaming (currently uses 2s polling — fine for signals, not for HFT)
- [ ] Greek-aware sizing (delta hedging, gamma scalping setups)
- [ ] Backtest engine with real Breeze historical data
- [ ] Telegram/email alert on signal fire
- [ ] Multi-leg strategies (straddle/strangle/iron condor screener)
- [ ] Auto-session-refresh via headless browser (security risk — opt-in)

---

## Legal

This is a personal decision-support tool. It does **not** place orders on your behalf. You are solely responsible for every trade. Past simulation performance does not predict future market behavior. Options trading involves substantial risk of loss.
