"""
trainer.py — Trains the three production models.

  1. win_classifier   — XGBoost  → P(trade is a winner)
  2. regime_classifier — Random Forest → regime label (5-class)
  3. premium_predictor — LightGBM regressor → expected % change in premium

Run:
    python trainer.py        # trains on synthetic data, saves models/
    python trainer.py --real # trains on real trade outcomes from data/trades.json
"""

import argparse
import json
import os
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, log_loss
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier
from lightgbm import LGBMRegressor

from features import vectorize_batch, column_names, REGIME_LEVELS, FEATURE_COUNT
from synth import make_dataset

MODELS_DIR = Path(__file__).parent / 'models'
MODELS_DIR.mkdir(exist_ok=True)


def train_win_classifier(X, y):
    print(f'[win-classifier] training on {len(y)} samples...')
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    model = XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        objective='binary:logistic',
        eval_metric='logloss',
        random_state=42,
        n_jobs=-1,
        verbosity=0
    )
    model.fit(X_train, y_train)
    pred = model.predict(X_test)
    proba = model.predict_proba(X_test)[:, 1]
    print(f'  accuracy: {accuracy_score(y_test, pred):.3f}')
    print(f'  log loss: {log_loss(y_test, proba):.3f}')
    print(classification_report(y_test, pred, target_names=['LOSS', 'WIN']))
    joblib.dump(model, MODELS_DIR / 'win_classifier.joblib')
    print(f'  saved → {MODELS_DIR / "win_classifier.joblib"}')


def synth_regime_dataset(n=4000):
    """
    Build (X, y) where X are featureVector rows and y is the actual regime
    label (NOT the one stored in fv['regime'] — we'll generate features that
    *correspond* to each regime).
    """
    from synth import RNG
    import random
    rows, labels = [], []
    for _ in range(n):
        regime = random.choice(REGIME_LEVELS[:-1])  # exclude 'unknown'
        fv = {
            'confidence_raw': float(RNG.uniform(30, 100)),
            'bullAlign': int(RNG.integers(0, 4)),
            'bearAlign': int(RNG.integers(0, 4)),
            'rsiV5': float(RNG.uniform(20, 80)),
            'rsiV15': float(RNG.uniform(20, 80)),
            'vwapDist': float(RNG.uniform(-1, 1)),
            'ema5_diff_pct': 0.0,
            'ema15_diff_pct': 0.0,
            'ema60_diff_pct': 0.0,
            'volRatio': float(RNG.uniform(0.5, 2.5)),
            'regimeConfidence': 0,
            'pcr': float(RNG.uniform(0.6, 1.5)),
            'atmIV': float(RNG.uniform(10, 28)),
            'ivPct': float(RNG.uniform(0, 100)),
            'ceOIChg': 0.0, 'peOIChg': 0.0, 'oiFlow': 0.0,
            'regime': regime, 'sessionPhase': 'morning', 'side': 'NO_TRADE',
        }
        # Make the technical features match the regime
        if regime == 'trending_up':
            fv['adxV'] = float(RNG.uniform(25, 45))
            fv['atrPct'] = float(RNG.uniform(0.10, 0.30))
            fv['ema5_diff_pct'] = float(RNG.uniform(0.10, 0.40))
            fv['ema15_diff_pct'] = float(RNG.uniform(0.05, 0.35))
            fv['ema60_diff_pct'] = float(RNG.uniform(0.05, 0.30))
            fv['rsiV5'] = float(RNG.uniform(55, 75))
        elif regime == 'trending_down':
            fv['adxV'] = float(RNG.uniform(25, 45))
            fv['atrPct'] = float(RNG.uniform(0.10, 0.30))
            fv['ema5_diff_pct'] = float(RNG.uniform(-0.40, -0.10))
            fv['ema15_diff_pct'] = float(RNG.uniform(-0.35, -0.05))
            fv['ema60_diff_pct'] = float(RNG.uniform(-0.30, -0.05))
            fv['rsiV5'] = float(RNG.uniform(25, 45))
        elif regime == 'ranging':
            fv['adxV'] = float(RNG.uniform(10, 20))
            fv['atrPct'] = float(RNG.uniform(0.08, 0.18))
            fv['ema5_diff_pct'] = float(RNG.uniform(-0.10, 0.10))
            fv['rsiV5'] = float(RNG.uniform(40, 60))
        elif regime == 'volatile':
            fv['adxV'] = float(RNG.uniform(20, 35))
            fv['atrPct'] = float(RNG.uniform(0.35, 0.65))
            fv['ema5_diff_pct'] = float(RNG.uniform(-0.3, 0.3))
            fv['volRatio'] = float(RNG.uniform(1.5, 3.0))
        elif regime == 'quiet':
            fv['adxV'] = float(RNG.uniform(5, 14))
            fv['atrPct'] = float(RNG.uniform(0.02, 0.08))
            fv['volRatio'] = float(RNG.uniform(0.3, 0.7))
        rows.append(fv)
        labels.append(REGIME_LEVELS.index(regime))
    return rows, labels


def train_regime_classifier():
    print('[regime-classifier] generating dataset...')
    rows, labels = synth_regime_dataset(4000)
    X = vectorize_batch(rows)
    y = np.array(labels)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    model = RandomForestClassifier(n_estimators=200, max_depth=10, random_state=42, n_jobs=-1)
    model.fit(X_train, y_train)
    pred = model.predict(X_test)
    print(f'  accuracy: {accuracy_score(y_test, pred):.3f}')
    joblib.dump(model, MODELS_DIR / 'regime_classifier.joblib')
    print(f'  saved → {MODELS_DIR / "regime_classifier.joblib"}')


def train_premium_predictor():
    """
    Predicts % change in option premium given spot move % and option features.
    Synthetic relationship: Δpremium% ≈ delta * spot_move% / (1 - theta_drag)
    """
    print('[premium-predictor] synthesizing premium-move dataset...')
    from synth import RNG
    n = 6000
    X_raw, y = [], []
    for _ in range(n):
        spot_move_pct = float(RNG.uniform(-1.5, 1.5))  # spot % change
        delta = float(RNG.uniform(0.20, 0.80))
        time_to_expiry = float(RNG.uniform(0.5, 14))  # days
        iv = float(RNG.uniform(10, 30))
        # Theta drag — rough heuristic: 1-2% premium per day, scaled by IV
        theta_drag = (iv / 20) * (1 / max(0.5, time_to_expiry)) * 0.8
        # If trade is held intraday, time component
        time_held_hrs = float(RNG.uniform(0.1, 5))
        premium_change_pct = delta * spot_move_pct * 100 / 50 - theta_drag * (time_held_hrs / 6) + RNG.normal(0, 2)
        X_raw.append([spot_move_pct, delta, time_to_expiry, iv, time_held_hrs])
        y.append(premium_change_pct)
    X = np.array(X_raw)
    y = np.array(y)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = LGBMRegressor(n_estimators=200, max_depth=5, learning_rate=0.05, verbose=-1)
    model.fit(X_train, y_train)
    score = model.score(X_test, y_test)
    print(f'  R²: {score:.3f}')
    joblib.dump(model, MODELS_DIR / 'premium_predictor.joblib')
    print(f'  saved → {MODELS_DIR / "premium_predictor.joblib"}')


def train_all_synthetic():
    print('=' * 60)
    print('Training all models on synthetic data')
    print('=' * 60)
    print()
    fvs, outcomes = make_dataset(8000)
    X = vectorize_batch(fvs)
    y = np.array(outcomes)
    train_win_classifier(X, y)
    print()
    train_regime_classifier()
    print()
    train_premium_predictor()
    print()
    print('All models saved to', MODELS_DIR)


def train_from_real_trades(trades_path: str):
    """
    Retrains win_classifier on real accumulated trades.
    trades_path: JSON file with [{ featureVector: {...}, result: 'WIN'|'LOSS' }, ...]
    """
    print(f'Loading real trades from {trades_path}')
    with open(trades_path) as f:
        trades = json.load(f)
    if len(trades) < 50:
        print(f'  Only {len(trades)} trades — too few for meaningful retraining (need 50+). Sticking with synthetic.')
        return
    fvs = [t['featureVector'] for t in trades if t.get('featureVector')]
    y = np.array([1 if t['result'] == 'WIN' else 0 for t in trades if t.get('featureVector')])
    X = vectorize_batch(fvs)
    print(f'  {len(y)} samples ({y.sum()} wins, {(1-y).sum()} losses)')
    train_win_classifier(X, y)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--real', help='Path to real trades JSON (for retraining)')
    args = ap.parse_args()
    if args.real:
        train_from_real_trades(args.real)
    else:
        train_all_synthetic()
