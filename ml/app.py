"""
app.py — FastAPI ML inference service.

Endpoints:
  POST /score    — score a single featureVector → win probability + regime + premium move
  POST /score/batch — score many featureVectors
  POST /retrain  — kick off retraining from accumulated real trades
  GET  /health   — service health + which models are loaded
  GET  /models   — list models + their metadata
"""

import os
import json
import time
import subprocess
from pathlib import Path
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
import joblib
import numpy as np
from dotenv import load_dotenv

from features import vectorize, vectorize_batch, REGIME_LEVELS

load_dotenv()

MODELS_DIR = Path(__file__).parent / 'models'
MODELS_DIR.mkdir(exist_ok=True)
PORT = int(os.environ.get('ML_PORT', '4400'))

app = FastAPI(title='QuantEdge ML', version='0.1.0')

# Globals — models loaded lazily on first request to keep startup fast
_models: Dict[str, Any] = {}
_loaded_at: Dict[str, float] = {}


def load_model(name: str):
    """Lazy-load a model and cache."""
    if name in _models:
        return _models[name]
    path = MODELS_DIR / f'{name}.joblib'
    if not path.exists():
        return None
    _models[name] = joblib.load(path)
    _loaded_at[name] = time.time()
    return _models[name]


def reload_models():
    """Force-reload all models from disk (used after retraining)."""
    _models.clear()
    _loaded_at.clear()
    for name in ('win_classifier', 'regime_classifier', 'premium_predictor'):
        load_model(name)


# ============================================================
#  Schemas
# ============================================================

class FeatureVector(BaseModel):
    """Loose schema — accepts any extra keys, validates only what we use."""
    confidence_raw: Optional[float] = 50
    bullAlign: Optional[int] = 0
    bearAlign: Optional[int] = 0
    rsiV5: Optional[float] = 50
    rsiV15: Optional[float] = 50
    atrPct: Optional[float] = 0.1
    vwapDist: Optional[float] = 0
    adxV: Optional[float] = 20
    ema5_diff_pct: Optional[float] = 0
    ema15_diff_pct: Optional[float] = 0
    ema60_diff_pct: Optional[float] = 0
    volRatio: Optional[float] = 1.0
    regimeConfidence: Optional[float] = 50
    pcr: Optional[float] = 1.0
    atmIV: Optional[float] = 15
    ivPct: Optional[float] = 50
    ceOIChg: Optional[float] = 0
    peOIChg: Optional[float] = 0
    oiFlow: Optional[float] = 0
    regime: Optional[str] = 'unknown'
    sessionPhase: Optional[str] = 'morning'
    side: Optional[str] = 'NO_TRADE'

    class Config:
        extra = 'allow'


class ScoreResponse(BaseModel):
    winProbability: float = Field(..., ge=0, le=1)
    winProbabilityPct: int
    confidence: str  # 'HIGH' | 'MEDIUM' | 'LOW'
    regimeFromML: Optional[str] = None
    regimeConfidence: Optional[float] = None
    expectedPremiumMovePct: Optional[float] = None
    edge: float  # winProb - 0.5; positive = edge in favor of the trade
    modelVersion: str = '0.1.0-synthetic'


class TradeRecord(BaseModel):
    featureVector: dict
    result: str  # 'WIN' or 'LOSS'
    pnl: Optional[float] = 0
    symbol: Optional[str] = ''
    time: Optional[float] = 0


# ============================================================
#  Endpoints
# ============================================================

@app.get('/health')
async def health():
    return {
        'ok': True,
        'service': 'quantedge-ml',
        'models_loaded': list(_models.keys()),
        'models_available': [p.stem for p in MODELS_DIR.glob('*.joblib')],
        'time': time.time()
    }


@app.get('/models')
async def models_info():
    out = []
    for p in MODELS_DIR.glob('*.joblib'):
        out.append({
            'name': p.stem,
            'path': str(p),
            'size_kb': p.stat().st_size // 1024,
            'modified': p.stat().st_mtime,
            'loaded': p.stem in _models
        })
    return out


@app.post('/score', response_model=ScoreResponse)
async def score(fv: FeatureVector):
    fv_dict = fv.dict()

    # 1. Win classifier
    win_model = load_model('win_classifier')
    if win_model is None:
        raise HTTPException(503, 'win_classifier not yet trained. Run trainer.py first.')

    x = vectorize(fv_dict).reshape(1, -1)
    win_prob = float(win_model.predict_proba(x)[0, 1])

    # 2. Regime classifier (independent of fv['regime'] — gives ML opinion)
    regime_from_ml = None
    regime_confidence = None
    regime_model = load_model('regime_classifier')
    if regime_model is not None:
        regime_proba = regime_model.predict_proba(x)[0]
        regime_idx = int(np.argmax(regime_proba))
        regime_from_ml = REGIME_LEVELS[regime_idx]
        regime_confidence = float(regime_proba[regime_idx])

    # 3. Expected premium move — use prior on delta & spot context
    expected_premium = None
    prem_model = load_model('premium_predictor')
    if prem_model is not None:
        # Heuristic spot move target: 1.5× ATR worth
        spot_move_pct = fv_dict.get('atrPct', 0.2) * 1.5
        # Sign by direction
        side = fv_dict.get('side', 'NO_TRADE')
        if side == 'BUY_PUT':
            spot_move_pct = -spot_move_pct
        # Conservative delta 0.5 (ATM), 2 days expiry, IV from fv, 2hr hold
        x_prem = np.array([[
            spot_move_pct, 0.5, 2.0,
            fv_dict.get('atmIV', 15), 2.0
        ]])
        expected_premium = float(prem_model.predict(x_prem)[0])

    edge = win_prob - 0.5
    if win_prob >= 0.62:
        conf = 'HIGH'
    elif win_prob >= 0.52:
        conf = 'MEDIUM'
    else:
        conf = 'LOW'

    return ScoreResponse(
        winProbability=win_prob,
        winProbabilityPct=int(round(win_prob * 100)),
        confidence=conf,
        regimeFromML=regime_from_ml,
        regimeConfidence=regime_confidence,
        expectedPremiumMovePct=expected_premium,
        edge=edge
    )


@app.post('/score/batch')
async def score_batch(fvs: List[FeatureVector]):
    if not fvs:
        return []
    win_model = load_model('win_classifier')
    if win_model is None:
        raise HTTPException(503, 'win_classifier not yet trained')
    X = vectorize_batch([fv.dict() for fv in fvs])
    probas = win_model.predict_proba(X)[:, 1]
    return [
        {'winProbability': float(p), 'winProbabilityPct': int(round(p * 100))}
        for p in probas
    ]


@app.post('/retrain')
async def retrain(background_tasks: BackgroundTasks, trades: Optional[List[TradeRecord]] = None):
    """
    Trigger retraining. If `trades` is provided, save them and retrain on
    real data. Otherwise retrain on synthetic data.
    """
    data_dir = Path(__file__).parent / 'data'
    data_dir.mkdir(exist_ok=True)

    if trades:
        trades_path = data_dir / 'trades.json'
        existing = []
        if trades_path.exists():
            existing = json.loads(trades_path.read_text())
        existing.extend([t.dict() for t in trades])
        trades_path.write_text(json.dumps(existing, indent=2))
        background_tasks.add_task(_retrain_real, str(trades_path))
        return {'ok': True, 'scheduled': 'real-data retrain', 'total_trades': len(existing)}
    else:
        background_tasks.add_task(_retrain_synth)
        return {'ok': True, 'scheduled': 'synthetic retrain'}


def _retrain_synth():
    subprocess.run(['python', str(Path(__file__).parent / 'trainer.py')], check=False)
    reload_models()


def _retrain_real(trades_path: str):
    subprocess.run(['python', str(Path(__file__).parent / 'trainer.py'), '--real', trades_path], check=False)
    reload_models()


@app.on_event('startup')
async def startup():
    # Pre-load all models so first request is fast
    for name in ('win_classifier', 'regime_classifier', 'premium_predictor'):
        load_model(name)
    print(f'[ml] startup complete. loaded: {list(_models.keys())}')
    print(f'[ml] listening on port {PORT}')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app:app', host='0.0.0.0', port=PORT, reload=False)
