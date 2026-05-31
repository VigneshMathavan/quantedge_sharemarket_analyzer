"""
features.py — Shared feature schema between Node signal engine and Python ML.

The Node SignalEngineV2 outputs a `featureVector` dict on every signal.
This module defines:
  - The canonical feature list (so we never train on garbage column orders)
  - One-hot encoders for categorical features (regime, session phase, side)
  - A vectorize() function used by both training and inference
"""

import numpy as np
import pandas as pd

# Numeric features in the exact order the model expects them
NUMERIC_FEATURES = [
    'confidence_raw',
    'bullAlign',
    'bearAlign',
    'rsiV5',
    'rsiV15',
    'atrPct',
    'vwapDist',
    'adxV',
    'ema5_diff_pct',
    'ema15_diff_pct',
    'ema60_diff_pct',
    'volRatio',
    'regimeConfidence',
    'pcr',
    'atmIV',
    'ivPct',
    'ceOIChg',
    'peOIChg',
    'oiFlow',
]

# Categorical features → one-hot
REGIME_LEVELS = ['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet', 'unknown']
SESSION_LEVELS = ['opening', 'morning', 'lunch', 'afternoon', 'close', 'auction', 'closed']
SIDE_LEVELS = ['BUY_CALL', 'BUY_PUT', 'NO_TRADE']


def vectorize(fv: dict) -> np.ndarray:
    """Convert a single featureVector dict into a flat numeric vector."""
    row = [float(fv.get(k, 0) or 0) for k in NUMERIC_FEATURES]
    # one-hot encode categoricals
    row += [1.0 if fv.get('regime') == r else 0.0 for r in REGIME_LEVELS]
    row += [1.0 if fv.get('sessionPhase') == s else 0.0 for s in SESSION_LEVELS]
    row += [1.0 if fv.get('side') == s else 0.0 for s in SIDE_LEVELS]
    return np.array(row, dtype=np.float32)


def vectorize_batch(fvs: list) -> np.ndarray:
    return np.stack([vectorize(fv) for fv in fvs])


FEATURE_COUNT = len(NUMERIC_FEATURES) + len(REGIME_LEVELS) + len(SESSION_LEVELS) + len(SIDE_LEVELS)


def column_names() -> list:
    return (
        NUMERIC_FEATURES
        + [f'regime_{r}' for r in REGIME_LEVELS]
        + [f'session_{s}' for s in SESSION_LEVELS]
        + [f'side_{s}' for s in SIDE_LEVELS]
    )
