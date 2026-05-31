# QuantEdge — Options Terminal

A Bloomberg-style intraday options trading assistant for **NIFTY** and **SENSEX**, focused on options buying.

**Three-service architecture:**
- **Node backend** (`server/`) — broker connection, signal engine v2, WebSocket relay
- **Python ML service** (`ml/`) — XGBoost + Random Forest + LightGBM, FastAPI
- **Static web frontend** (`web/`) — Bloomberg-style fixed 3-column layout

## Honest claims

- **Not** a 90% accuracy system. No retail system is. Anyone selling that is lying.
- Realistic target: **55–62% win rate at 1:2 R:R**, which is profitable over 50+ trades.
- This is a **decision-support tool**, not an auto-trader. You place every order yourself.
- Mock-data mode works without any broker credentials.

---

## Architecture

```
quantedge/
├── server/                Node.js backend (Express + WebSocket)
│   ├── index.js           REST + WS relay; orchestrates everything
│   ├── breeze.js          Provider abstraction (Breeze + mock)
│   ├── signal.js          v1 — original 8-condition rule engine
│   ├── signal2.js         v2 — multi-TF + regime + IV + time-of-day + ML hooks
│   └── backtest.js        Walk-forward backtester + ML training data export
│
├── ml/                    Python FastAPI ML service
│   ├── app.py             /score endpoint (called by Node)
│   ├── trainer.py         Trains XGBoost / RF / LGBM
│   ├── features.py        Shared feature schema (Node ↔ Python contract)
│   ├── synth.py           Synthetic training data generator (priors only)
│   └── requirements.txt
│
└── web/                   Vanilla HTML/CSS/JS frontend
    ├── index.html         3-column fixed layout
    ├── styles.css         Modern dark theme
    ├── market.js          REST + WS client
    └── app.js             UI + chart + signal rendering
```

---

## Signal Engine v2 — what's different from v1

The v2 engine in `signal2.js` is a significant upgrade. Key changes:

| Feature | v1 | v2 |
|---|---|---|
| Timeframes | Single (whatever you feed it) | **3 timeframes** (5m + 15m + 1H) resampled, confluence required |
| Regime detection | None | **5-state classifier** (trending_up/down, ranging, volatile, quiet) |
| Time-of-day filter | None | **Hard gates** on opening 15min, lunch, last 45min |
| IV awareness | Loose | **IV percentile** vs 30-session history |
| Strike selection | Heuristic | **Delta-aware** + regime-aware (ITM in trends, ATM in volatility) |
| Position sizing | Fixed % | **Risk-of-ruin adjuster** (cuts size after consecutive losses) |
| Conditions scored | 8 | **12** (added regime alignment, OI flow, session quality, directional conviction) |
| ML integration | None | **Feature vector** export + win-prob hook to Python service |
| Skip bias | Soft | **Hard** — refuses LOW tier and any session-blocked candle |

## ML Stack — what each model does

Honest framing: ML in trading adds **+3-5% win rate** over a well-tuned rule engine. It's not magic. Train it on synthetic priors first; retrain on real trades as they accumulate.

| Model | Type | Input | Output |
|---|---|---|---|
| `win_classifier` | XGBoost binary | 19 numeric + 18 one-hot features | P(trade wins) |
| `regime_classifier` | Random Forest | Same feature vector | Regime label + confidence |
| `premium_predictor` | LightGBM regressor | Spot move %, delta, IV, time held | Expected % change in premium |

---

## Quick start — mock mode (no credentials)

### 1. Backend
```powershell
cd quantedge/server
npm install
npm start
# → listens on http://localhost:4300 in mock mode
```

### 2. ML service (optional but recommended)
```powershell
cd quantedge/ml
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python trainer.py            # trains on synthetic data, ~30 sec
python app.py                # listens on http://localhost:4400
```

### 3. Frontend
```powershell
cd quantedge/web
npx --yes http-server . -p 5180 -c-1
# Open http://localhost:5180
```

You'll see the terminal with mock NIFTY/SENSEX/FINNIFTY data. Status pill says **"Mock data"**.

---

## Running the backtester

The backtest framework walks the engine candle-by-candle and simulates trade outcomes in option premium space.

### CLI
```powershell
cd quantedge/server
node backtest.js NIFTY 5minute 500
```

Outputs:
- Win rate, profit factor, max DD, Sharpe
- Win rate by **tier** (HIGH/MEDIUM/LOW)
- Win rate by **regime**
- Full trade log JSON → `data/backtest_NIFTY_*.json`
- Training data export → `data/training_NIFTY.json`

### As an HTTP endpoint
```bash
curl -X POST http://localhost:4300/api/backtest \
  -H "Content-Type: application/json" \
  -d '{"symbol":"NIFTY","timeframe":"5minute","count":500,"accountSize":500000,"riskPercent":2}'
```

### Retrain ML from backtest results
```bash
curl -X POST http://localhost:4300/api/ml/retrain-from-backtest \
  -H "Content-Type: application/json" \
  -d '{"symbol":"NIFTY","count":1000}'
```

---

## Endpoints reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Backend status + mode |
| `GET` | `/api/quote/:symbol` | Latest quote |
| `GET` | `/api/historical/:symbol` | OHLC candles (`?interval=5minute&count=200`) |
| `GET` | `/api/option-chain/:symbol` | Option chain (`?expiry=...`) |
| `GET` | `/api/session` | Current session phase |
| `GET` | `/api/regime/:symbol` | Current regime classification |
| `POST` | `/api/signal/evaluate` | Evaluate signal (defaults to v2 engine) |
| `POST` | `/api/trade/record` | Record a trade outcome |
| `GET` | `/api/trades/recent` | Last 50 trades |
| `POST` | `/api/backtest` | Run backtest |
| `POST` | `/api/ml/retrain-from-backtest` | Generate training data + retrain ML |
| `WS` | `/ws` | Real-time tick stream |

ML service (`http://localhost:4400`):
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Service status |
| `POST` | `/score` | Score a single featureVector |
| `POST` | `/score/batch` | Score many at once |
| `POST` | `/retrain` | Trigger retrain (synth or real-data) |

---

## Going live — broker integration

The current `breeze.js` adapter is for **ICICI Direct Breeze Connect**. **Kotak Neo integration is the next session's work.**

### What you'll need from Kotak (next session)
1. Activate Kotak Neo Trade API: app → Invest → Trade API → API Dashboard → Create Application
2. After activation email: login to `https://napi.kotaksecurities.com/devportal/apis`
3. Collect: **Consumer Key**, **Consumer Secret**, **TOTP Secret** (from Authenticator setup)
4. Paste into `server/.env`

The Kotak adapter will auto-generate TOTP codes from your secret — no daily OTP typing.

---

## Configuration (`server/.env`)

```bash
# Current — Breeze (will be replaced by Kotak)
BREEZE_API_KEY=
BREEZE_API_SECRET=
BREEZE_SESSION_TOKEN=
USE_MOCK=true                   # set false once creds are real

# Server
PORT=4300
WEB_ORIGIN=http://localhost:5180

# ML service
ML_URL=http://localhost:4400
ML_ENABLED=true                 # set false to skip ML scoring entirely
```

---

## Roadmap

**Done:**
- [x] Provider abstraction with mock fallback
- [x] Signal engine v2 (multi-TF, regime, IV, time-of-day, ML hooks)
- [x] Python ML service (XGBoost + RF + LightGBM)
- [x] Walk-forward backtester
- [x] Feature vector contract Node ↔ Python
- [x] HTTP endpoints for backtest + ML retrain
- [x] End-to-end smoke test on mock data

**Next session:**
- [ ] Kotak Neo provider with auto-TOTP (needs your credentials)
- [ ] Real historical backtests + ML retrain on real data
- [ ] Frontend updates to render ML probability + regime + premium prediction
- [ ] Supabase Postgres for trade history persistence
- [ ] Deployment configs (Vercel + Railway)

---

## Legal

Personal decision-support tool. Does **not** place orders. You are responsible for every trade. Past simulated performance does not predict future market behavior. Options trading involves substantial risk of loss including total premium paid.
