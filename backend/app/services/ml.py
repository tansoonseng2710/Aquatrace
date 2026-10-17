"""Per-compound regression models relating sensor readings to HPLC concentration.

The output is always a *screening estimate* with an uncertainty interval and a confidence label,
never a replacement for HPLC. Validation is k-fold cross-validation; optionally grouped by
sampling station (GroupKFold) to test transfer to unseen locations.
"""
from __future__ import annotations

import math
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .. import config

DEFAULT_FEATURES = list(config.SENSOR_FIELDS)
MIN_SAMPLES = 12


def build(algo: str, seed: int = 1234):
    if algo == "ridge":
        return make_pipeline(StandardScaler(), Ridge(alpha=1.0))
    return RandomForestRegressor(n_estimators=200, max_depth=8, min_samples_leaf=3, max_features=0.5,
                                 random_state=seed, n_jobs=-1)


def _perm_importance(model, X, y, rng) -> np.ndarray:
    base = mean_squared_error(y, model.predict(X))
    out = np.zeros(X.shape[1])
    for j in range(X.shape[1]):
        Xp = X.copy(); Xp[:, j] = rng.permutation(Xp[:, j])
        out[j] = max(0.0, mean_squared_error(y, model.predict(Xp)) - base)
    return out


def train(X: np.ndarray, y: np.ndarray, features: list[str], algo: str = "rf", groups=None, seed: int = 1234) -> dict:
    n = len(y)
    if n < MIN_SAMPLES:
        raise ValueError(f"Only {n} paired samples; at least {MIN_SAMPLES} are needed (30+ recommended).")
    rng = np.random.default_rng(seed)
    if groups is not None and len(set(groups)) >= 3:
        splitter, split_args, scheme = GroupKFold(n_splits=min(5, len(set(groups)))), (X, y, groups), "GroupKFold by station"
    else:
        splitter, split_args, scheme = KFold(n_splits=min(5, n), shuffle=True, random_state=seed), (X,), "KFold (shuffled)"
    oof = np.zeros(n); imp = np.zeros(X.shape[1]); oof_uv = np.full(n, np.nan)
    uv_i = features.index("uv") if "uv" in features else None
    for tr, te in splitter.split(*split_args):
        m = build(algo, seed).fit(X[tr], y[tr])
        oof[te] = m.predict(X[te])
        imp += _perm_importance(m, X[te], y[te], rng)
        if uv_i is not None:
            b, a = np.polyfit(X[tr, uv_i], y[tr], 1)
            oof_uv[te] = a + b * X[te, uv_i]
    final = build(algo, seed).fit(X, y)
    rmse = float(math.sqrt(mean_squared_error(y, oof)))
    metrics = {
        "n": int(n), "r2_cv": float(r2_score(y, oof)), "rmse": rmse, "mae": float(mean_absolute_error(y, oof)),
        "r2_train": float(r2_score(y, final.predict(X))), "bias": float((y - oof).mean()),
        "r2_uv_only": float(r2_score(y, oof_uv)) if uv_i is not None else None, "cv": scheme,
        "importance": {f: float(v) for f, v in zip(features, imp / (imp.sum() or 1))},
        "corr": {f: float(np.corrcoef(X[:, j], y)[0, 1]) if X[:, j].std() > 0 else 0.0 for j, f in enumerate(features)},
        "ranges": {f: [float(X[:, j].min()), float(X[:, j].max())] for j, f in enumerate(features)},
        "oof": [[float(a), float(b)] for a, b in zip(y, oof)],
    }
    return {"model": final, "metrics": metrics, "features": features, "algo": algo}


def predict(bundle: dict, x: dict) -> dict | None:
    """Estimate + 95% interval + confidence for one feature dict."""
    return predict_batch(bundle, [x])[0]


def predict_batch(bundle: dict, xs: list[dict]) -> list[dict | None]:
    """Vectorised version used when re-scoring history."""
    feats, m = bundle["features"], bundle["model"]
    V = np.array([[x.get(f, np.nan) for f in feats] for x in xs], dtype=float)
    ok = ~np.isnan(V).any(axis=1)
    out: list[dict | None] = [None] * len(xs)
    if not ok.any():
        return out
    Vo = V[ok]
    if hasattr(m, "estimators_"):
        T = np.stack([t.predict(Vo) for t in m.estimators_])
        mus, spreads = T.mean(axis=0), T.std(axis=0)
    else:
        mus, spreads = m.predict(Vo), np.zeros(len(Vo))
    for i, idx in enumerate(np.flatnonzero(ok)):
        out[idx] = _interval(bundle, Vo[i], float(mus[i]), float(spreads[i]))
    return out


def _interval(bundle: dict, v: np.ndarray, mu: float, spread: float) -> dict:
    feats, met = bundle["features"], bundle["metrics"]
    mu = max(0.0, mu)
    v = v[None, :]
    hw = 1.96 * math.sqrt(spread ** 2 + met["rmse"] ** 2)
    outside = []
    for j, f in enumerate(feats):
        lo, hi = met["ranges"][f]; pad = 0.1 * ((hi - lo) or abs(lo) * 0.1 or 1)
        if v[0, j] < lo - pad or v[0, j] > hi + pad:
            outside.append(f)
    rel = hw / max(mu, 1e-9)
    conf = "High" if rel < 0.5 else "Medium" if rel < 1.0 else "Low"
    if met["r2_cv"] < 0.5 or outside:
        conf = "Low"
    elif met["r2_cv"] < 0.7 and conf == "High":
        conf = "Medium"
    return {"mu": mu, "lo": max(0.0, mu - hw), "hi": mu + hw, "conf": conf, "outside": outside}


def save(bundle: dict, compound: str, version: int) -> str:
    config.MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = Path(config.MODEL_DIR) / f"{compound}_v{version}.joblib"
    joblib.dump(bundle, path)
    return str(path)


def load(path: str) -> dict:
    return joblib.load(path)
