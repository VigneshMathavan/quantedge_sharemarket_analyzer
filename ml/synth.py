"""
synth.py — Synthetic training data generator.

We don't yet have real trade outcomes. To boot the ML models with something
sensible (not random), we generate synthetic featureVector → outcome pairs
that encode the *priors* a seasoned options trader would have:

  • Bullish multi-TF alignment + bullish regime + cheap IV + above-VWAP →
    BUY_CALL with higher win probability
  • Bearish multi-TF + falling momentum → BUY_PUT
  • Lunch hour, high IV, ranging regime → low win probability regardless
  • Strong ADX + aligned direction → boosts probability

The model trained on this won't be magic — it'll just learn these priors
in a calibrated, weighted way. When real trade outcomes accumulate, we
retrain on those and the synthetic priors get overwritten.
"""

import numpy as np
import random

RNG = np.random.default_rng(seed=42)


def random_feature_vector():
    bull_align = int(RNG.integers(0, 4))
    bear_align = int(RNG.integers(0, 4 - bull_align if bull_align < 3 else 1))
    side = 'BUY_CALL' if bull_align >= 2 else 'BUY_PUT' if bear_align >= 2 else 'NO_TRADE'

    regime_choices = ['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet']
    regime = random.choice(regime_choices)
    session_choices = ['opening', 'morning', 'lunch', 'afternoon', 'close']
    session = random.choices(session_choices, weights=[0.05, 0.40, 0.20, 0.30, 0.05])[0]

    fv = {
        'confidence_raw': float(RNG.uniform(30, 100)),
        'bullAlign': bull_align,
        'bearAlign': bear_align,
        'rsiV5': float(RNG.uniform(25, 80)),
        'rsiV15': float(RNG.uniform(25, 80)),
        'atrPct': float(RNG.uniform(0.05, 0.6)),
        'vwapDist': float(RNG.uniform(-1.0, 1.0)),
        'adxV': float(RNG.uniform(8, 45)),
        'ema5_diff_pct': float(RNG.uniform(-0.5, 0.5)),
        'ema15_diff_pct': float(RNG.uniform(-0.5, 0.5)),
        'ema60_diff_pct': float(RNG.uniform(-0.5, 0.5)),
        'volRatio': float(RNG.uniform(0.4, 3.0)),
        'regimeConfidence': float(RNG.uniform(40, 95)),
        'pcr': float(RNG.uniform(0.5, 1.7)),
        'atmIV': float(RNG.uniform(9, 30)),
        'ivPct': float(RNG.uniform(0, 100)),
        'ceOIChg': float(RNG.uniform(-300000, 300000)),
        'peOIChg': float(RNG.uniform(-300000, 300000)),
        'oiFlow': float(RNG.uniform(-300000, 300000)),
        'regime': regime,
        'sessionPhase': session,
        'side': side,
    }
    # consistency: keep oiFlow roughly aligned with direction
    if side == 'BUY_CALL':
        fv['oiFlow'] = float(RNG.uniform(-100000, 400000))
    elif side == 'BUY_PUT':
        fv['oiFlow'] = float(RNG.uniform(-400000, 100000))
    return fv


def simulate_outcome(fv: dict) -> int:
    """
    Returns 1 (win) or 0 (loss) based on heuristic edge.
    Base win rate 50%. Modulated by confluence quality.
    """
    p = 0.50

    # Multi-TF alignment is the biggest edge
    align = max(fv['bullAlign'], fv['bearAlign'])
    p += (align - 1) * 0.04  # +4% per extra TF aligned

    # Regime alignment with direction
    if fv['side'] == 'BUY_CALL' and fv['regime'] == 'trending_up':
        p += 0.10
    elif fv['side'] == 'BUY_PUT' and fv['regime'] == 'trending_down':
        p += 0.10
    elif fv['regime'] == 'volatile':
        p -= 0.05  # whipsaws
    elif fv['regime'] == 'quiet':
        p -= 0.08  # dead market eats premium

    # ADX strength
    if fv['adxV'] > 25:
        p += 0.05
    elif fv['adxV'] < 15:
        p -= 0.03

    # Volume confirmation
    if fv['volRatio'] > 1.5:
        p += 0.04

    # IV percentile — cheap IV is good for buyers
    if fv['ivPct'] < 35:
        p += 0.04
    elif fv['ivPct'] > 75:
        p -= 0.06  # expensive premium, hard to win

    # PCR vs direction
    if fv['side'] == 'BUY_CALL' and fv['pcr'] > 1.1:
        p += 0.03
    elif fv['side'] == 'BUY_PUT' and fv['pcr'] < 0.85:
        p += 0.03

    # OI flow agrees with direction
    if fv['oiFlow'] > 50000:
        p += 0.03

    # Session quality
    if fv['sessionPhase'] in ('opening', 'lunch', 'auction'):
        p -= 0.10
    elif fv['sessionPhase'] == 'morning':
        p += 0.04

    # ATR sweet spot
    if 0.10 < fv['atrPct'] < 0.30:
        p += 0.03
    elif fv['atrPct'] > 0.45:
        p -= 0.04

    # RSI extremes — overbought CE / oversold PE = lower edge
    if fv['side'] == 'BUY_CALL' and fv['rsiV5'] > 72:
        p -= 0.05
    elif fv['side'] == 'BUY_PUT' and fv['rsiV5'] < 28:
        p -= 0.05

    # NO_TRADE side → simulate as a missed setup. Outcome is essentially noise.
    if fv['side'] == 'NO_TRADE':
        p = 0.30  # if you trade these, you lose more often

    p = max(0.05, min(0.92, p))
    return 1 if RNG.random() < p else 0


def make_dataset(n: int = 5000):
    X, y = [], []
    for _ in range(n):
        fv = random_feature_vector()
        outcome = simulate_outcome(fv)
        X.append(fv)
        y.append(outcome)
    return X, y
