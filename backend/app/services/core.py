"""Shared scientific logic: geodesy, units, anomaly baseline, HPLC matching, reactor kinetics.

Kept deliberately close to the dashboard's JavaScript so both give the same answers.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable

import numpy as np

from .. import config

UNIT_TO_UG = {"ng/L": 1e-3, "µg/L": 1.0, "ug/L": 1.0, "mg/L": 1e3, "particles/L": 1.0}


def aware(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; everything in this app is UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_ts(v) -> datetime:
    if isinstance(v, datetime):
        return aware(v)
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, tz=timezone.utc)
    s = str(v).strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    return aware(dt).astimezone(timezone.utc)


def dist_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def convert(value: float, from_unit: str, to_unit: str) -> float | None:
    a = UNIT_TO_UG.get(from_unit.replace("u", "µ")) or UNIT_TO_UG.get(from_unit)
    b = UNIT_TO_UG.get(to_unit)
    if a is None or b is None:
        return None
    return value * a / b


# ---------------------------------------------------------------- anomaly baseline
def zone_of(conductivity: float | None) -> str:
    """Salinity class. Baselines are kept per class so moving from river to sea is not itself an anomaly."""
    c = conductivity or 0
    return "coast" if c > 25000 else "estuary" if c > 2500 else "river"


def zval(k: str, x: float) -> float:
    return math.log10(max(x, 1.0)) if k == "conductivity" else x


@dataclass
class Baseline:
    """Exponentially weighted mean/variance per (device, zone, parameter)."""
    window: int = config.BASELINE_WINDOW
    z_th: float = config.Z_THRESHOLD
    state: dict = field(default_factory=dict)

    def score(self, device: str, reading: dict) -> tuple[str, dict]:
        zone = zone_of(reading.get("conductivity"))
        B = self.state.setdefault((device, zone), {})
        a = 2 / (self.window + 1)
        z = {}
        for k in config.SENSOR_FIELDS:
            x = reading.get(k)
            if x is None:
                continue
            x = zval(k, x)
            b = B.get(k)
            if b is None:
                B[k] = {"m": x, "v": (abs(x) * 0.05 + 1e-3) ** 2, "n": 1}
                z[k] = 0.0
                continue
            zz = (x - b["m"]) / math.sqrt(b["v"] + 1e-12)
            z[k] = 0.0 if b["n"] < 12 else round(zz, 3)
            aa = a * 0.25 if abs(zz) > self.z_th else a
            d = x - b["m"]
            b["m"] += aa * d
            b["v"] = (1 - aa) * (b["v"] + aa * d * d)
            b["n"] += 1
        return zone, z


def status_for(z: dict, est: dict | None, level: float | None, z_th: float = config.Z_THRESHOLD) -> str:
    st = "ok"
    if z and max(abs(v) for v in z.values()) >= z_th:
        st = "warn"
    if est and level:
        if est["mu"] >= level:
            st = "bad"
        elif est["mu"] >= 0.7 * level and st == "ok":
            st = "warn"
    return st


# ---------------------------------------------------------------- HPLC <-> sensor matching
def match_sample(sample: dict, readings: Iterable[dict], win_min=config.MATCH_WINDOW_MIN, dist_max=config.MATCH_DIST_M) -> dict:
    """Weighted average of readings within ±win_min and dist_max of a lab sample.
    Weight = 1/(1+Δt[min]) · 1/(1+d/50 m). Returns {ok, n, dt_min, dist_m, sensors}."""
    if sample.get("sensors"):
        return {"ok": True, "n": 1, "dt_min": 0.0, "dist_m": 0.0, "sensors": dict(sample["sensors"]), "direct": True}
    t0 = parse_ts(sample["ts"])
    pool = []
    for r in readings:
        dt = abs((aware(r["ts"]) - t0).total_seconds()) / 60
        if dt > win_min:
            continue
        d = dist_m(sample["lat"], sample["lon"], r["lat"], r["lon"])
        if d <= dist_max:
            pool.append((r, d, dt))
    if not pool:
        return {"ok": False}
    wsum, agg = 0.0, {k: 0.0 for k in config.SENSOR_FIELDS}
    for r, d, dt in pool:
        w = 1 / (1 + dt) * 1 / (1 + d / 50)
        wsum += w
        for k in config.SENSOR_FIELDS:
            agg[k] += w * (r.get(k) or 0.0)
    agg = {k: v / wsum for k, v in agg.items()}
    best = min(pool, key=lambda p: p[2] + p[1] * 1000)
    return {"ok": True, "n": len(pool), "dt_min": best[2], "dist_m": best[1], "sensors": agg}


def add_time_features(sensors: dict, ts: datetime, lat: float, lon: float) -> dict:
    # Local hour (UTC+8 for Malaysia); change TZ_OFFSET_H for other deployments.
    h = (aware(ts).hour + 8) % 24
    return {**sensors, "hour_sin": math.sin(2 * math.pi * h / 24), "hour_cos": math.cos(2 * math.pi * h / 24), "lat": lat, "lon": lon}


# ---------------------------------------------------------------- photocatalytic reactor
def kinetics(rows: list[dict]) -> dict:
    """Pseudo-first-order fit ln(C0/C) = k·t through the origin, removal efficiency, TOC reduction."""
    rows = sorted(rows, key=lambda r: r["time_h"])
    c0 = rows[0]["conc"]
    pts = [(r["time_h"], math.log(c0 / r["conc"])) for r in rows if r["time_h"] > 0 and r["conc"] > 0]
    t = np.array([p[0] for p in pts]); y = np.array([p[1] for p in pts])
    k = float((t * y).sum() / (t * t).sum()) if len(t) else 0.0
    ss_res = float(((y - k * t) ** 2).sum()); ss_tot = float(((y - y.mean()) ** 2).sum()) if len(y) else 0
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    end = rows[-1]
    toc = (1 - end["toc"] / rows[0]["toc"]) * 100 if rows[0].get("toc") and end.get("toc") is not None else None
    return {"C0": c0, "Cend": end["conc"], "removal_pct": (1 - end["conc"] / c0) * 100, "k_per_h": k, "r2": r2,
            "t_end_h": end["time_h"], "half_life_min": math.log(2) / k * 60 if k > 0 else None, "toc_removal_pct": toc}


def reactor_verdict(run: dict, controls: list[dict], replicates: list[dict]) -> dict:
    """Decide from data whether the run shows a photocatalytic effect beyond controls."""
    k = kinetics(run["rows"])
    if run["catalyst"] == "none" or run["light"] == "dark":
        return {"verdict": "control", "detail": "Control run defines the baseline.", **k}
    if not controls:
        return {"verdict": "inconclusive", "detail": "No photolysis or dark-adsorption control.", **k}
    ck = [kinetics(c["rows"]) for c in controls]
    best = max(c["removal_pct"] for c in ck)
    kr = k["k_per_h"] / max(max(c["k_per_h"] for c in ck), 1e-6)
    net = k["removal_pct"] - best
    ok = net >= 20 and kr >= 3 and k["r2"] >= 0.9
    reps = [kinetics(r["rows"])["removal_pct"] for r in replicates]
    return {"verdict": "supported" if ok else "not_supported", "net_removal_pct": net, "k_ratio": kr,
            "replicate_sd": float(np.std([k["removal_pct"], *reps], ddof=1)) if reps else None,
            "criteria": "net ≥ 20 points, k ≥ 3× fastest control, R² ≥ 0.9", **k}
