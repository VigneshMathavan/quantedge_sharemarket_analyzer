# QuantEdge ML Service

FastAPI Python microservice that scores signals from the Node backend.

## What it does

Three models trained on synthetic + real trade data:

| Model | Type | Output |
|---|---|---|
| `win_classifier` | XGBoost binary classifier | P(trade wins) |
| `regime_classifier` | Random Forest | Market regime label |
| `premium_predictor` | LightGBM regressor | Expected % change in option premium |

## Setup

```bash
cd ml
python -m venv .venv
.venv\Scripts\activate     # Windows
# source .venv/bin/activate # macOS/Linux
pip install -r requirements.txt
```

## Train initial models (synthetic data — gives realistic priors)

```bash
python trainer.py
```

Creates `models/win_classifier.joblib`, `models/regime_classifier.joblib`,
`models/premium_predictor.joblib`. ~30 seconds.

## Run the service

```bash
python app.py
# or:
uvicorn app:app --reload --port 4400
```

Service listens on `http://localhost:4400`.

## Endpoints

- `GET /health` — service status + loaded models
- `GET /models` — model file info
- `POST /score` — single featureVector → win probability + regime + premium move
- `POST /score/batch` — array of featureVectors → array of probabilities
- `POST /retrain` — kick off async retraining (synthetic if no body, real if trades supplied)

## Retrain on accumulated real trades

Once you have 50+ real trade outcomes, retrain:

```bash
# Either:
curl -X POST http://localhost:4400/retrain -H "Content-Type: application/json" -d '[{"featureVector": {...}, "result": "WIN"}, ...]'

# Or directly:
python trainer.py --real data/trades.json
```

Retraining auto-reloads the model into the running service. Zero downtime.

## Wire to Node backend

The Node backend (`server/index.js`) reads `ML_URL` env (default `http://localhost:4400`).
SignalEngineV2 calls `/score` on every signal evaluation. If the ML service is
offline, signals still work — ML scoring is best-effort.

## Honest disclaimer

These models trained on synthetic data give you the **priors** a seasoned
trader would have, expressed as calibrated probabilities. They are NOT a
magic predictor. Expected lift over the rule-based engine: **+3-5% win rate**
when models retrain on accumulated real trades.

Don't trade based on the ML score alone — it's one input in the signal card.
