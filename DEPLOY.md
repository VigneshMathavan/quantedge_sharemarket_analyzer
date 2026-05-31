# QuantEdge — Deploy Guide (Railway + Vercel)

Full production deployment in ~30 minutes. Backend on Railway (always-on, $0-5/mo), frontend on Vercel (free).

## Architecture
```
┌────────────────────┐         ┌────────────────────────┐
│  Vercel (frontend) │ ──────▶ │  Railway (backend)     │
│  static HTML/JS    │  HTTPS  │  Node + Express + WS   │
│  free tier         │   /ws   │  Hobby $5/mo           │
└────────────────────┘         └─────────┬──────────────┘
                                          │
                                          ▼
                                  ┌───────────────┐
                                  │ Upstox API    │
                                  │ (live data)   │
                                  └───────────────┘
```

## 1. Push the code (5 min)

```bash
cd C:/Users/vigne/Downloads/quantedge

git remote add origin https://github.com/VigneshMathavan/quantedge_sharemarket_analyzer.git
git add .
git commit -m "Production deploy: Railway + Vercel configs"
git push -u origin main
```

If push errors with "non-fast-forward", run `git pull --rebase origin main` first then push.

## 2. Deploy backend to Railway (10 min)

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Select `VigneshMathavan/quantedge_sharemarket_analyzer`
3. Railway auto-detects Node from `package.json` and `railway.toml`
4. Click **Variables** tab → add these (paste from your local `server/.env`):
   ```
   BROKER=upstox
   UPSTOX_API_KEY=...
   UPSTOX_API_SECRET=...
   UPSTOX_ACCESS_TOKEN=...
   UPSTOX_EXTENDED_TOKEN=...
   UPSTOX_REDIRECT_URI=https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/auth/upstox/callback
   INDIANAPI_KEY=...
   WEB_ORIGIN=https://YOUR-VERCEL-DOMAIN.vercel.app
   ML_ENABLED=false
   ```
5. Click **Settings → Networking → Generate Domain**. Copy the public URL (something like `quantedge-production-abcd.up.railway.app`).
6. Railway deploys. Hit `https://YOUR-RAILWAY-DOMAIN/api/health` — should return `{"ok":true,"mode":"live"}`.

**Important**: Add `/api/auth/upstox/callback` to your Upstox developer console redirect URI list.

## 3. Deploy frontend to Vercel (10 min)

1. Go to https://vercel.com → **Add New** → **Project**
2. Import `VigneshMathavan/quantedge_sharemarket_analyzer`
3. **Framework Preset**: Other (don't pick a framework)
4. **Root Directory**: leave as `.` (repo root)
5. **Build Command**: leave empty
6. **Output Directory**: `web`
7. Open `vercel.json` in the repo — replace BOTH occurrences of `REPLACE_WITH_RAILWAY_URL` with your Railway domain (without `https://`).
8. Commit the change to GitHub. Vercel auto-redeploys.
9. Get your URL, e.g. `https://quantedge-sharemarket-analyzer.vercel.app`

## 4. Fetch historical data on Railway (5 min, one-time)

The 300 MB of historical candles is gitignored. Run this once after deploy:

```bash
# Railway → your service → Settings → Public Networking → SSH (or use the Railway CLI)
railway run npm run fetch:history
```

This populates `data/historical/` on the Railway volume. Models in `data/path-forecaster-rf.json` are already committed so AI works immediately.

## 5. Smoke test

Open `https://your-vercel-url.vercel.app`:
- 🟢 UP pill in top-right showing `5SC8SJ · EXT · 365d left`
- Live NIFTY price ticker
- Multi-TF Scan strip populates
- Best Strike Now panel shows CALL + PUT cards with greeks
- Chart loads with EMA, VWAP, pattern markers

## Common gotchas

| Problem | Fix |
|---|---|
| CORS error in browser console | Add Vercel URL to `WEB_ORIGIN` env on Railway |
| `vercel.json` rewrites failing | Make sure you replaced `REPLACE_WITH_RAILWAY_URL` |
| Backend can't access Upstox | Check token validity at `/api/auth/upstox/status` |
| WebSocket disconnects | Ensure Railway domain in vercel.json `/ws` rewrite |
| Out of memory on Railway | Hobby plan gives 48 GB — won't happen. Trial 512 MB — OK for us |

## Daily ritual (after deploy)

The Extended token lasts 366 days — **no daily action needed for data**.

When you eventually wire order placement, click the 🔴 UP pill in your live URL each morning at 09:14 IST to refresh the daily token (15 sec).
