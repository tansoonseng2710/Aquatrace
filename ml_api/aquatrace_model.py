"""AquaTrace model engine: runs the model package exported by the Colab notebook.

The package holds, for each medicine, random forests as plain arrays:
  - screening: the probability that the medicine is above the "high" level, either
      one-step  (clf_trees: P(high) directly), or
      two-step  (det_trees: P(detected) x cond_trees: P(high | detected));
    a model may also use the season (month of the reading) as two extra inputs
  - a level regressor: log10 concentration (ng/L) when the medicine is present
Each tree is a list of nodes: [feature, threshold, left, right] for a split, [value] for a leaf.

Alerts: red = P(high) >= p_threshold (send to lab), amber = P(high) >= p_amber (watch), else green.

The split rule is scikit-learn's: inputs are rounded to 32-bit floats, then x <= threshold goes left.
So this file gives the same numbers as the Colab notebook and the website, with no scikit-learn needed.
"""
import datetime as dt
import json
import math
import re
import struct
from pathlib import Path

SENSORS = {
    "ph": "pH",
    "temp": "Temperature (°C)",
    "conductivity": "Conductivity (µS/cm)",
    "turbidity": "Turbidity (NTU)",
    "do": "Dissolved oxygen (mg/L)",
}


# month on a circle, rounded to 6 decimals (the notebook stores the same table in the package)
DEFAULT_SEASON = {"m_sin": [round(math.sin(2 * math.pi * m / 12), 6) for m in range(1, 13)],
                  "m_cos": [round(math.cos(2 * math.pi * m / 12), 6) for m in range(1, 13)]}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
VERDICT = {"red": "Send this sample to the lab", "amber": "Watch this spot: take a second reading", "green": "No lab test needed"}


def month_of(readings: dict):
    """Month 1-12 from 'month', else from a 'timestamp' like 2026-10-17T..., else None."""
    m = readings.get("month")
    if m is not None:
        try:
            m = int(float(m))
            if 1 <= m <= 12:
                return m
        except (TypeError, ValueError):
            pass
    ts = readings.get("timestamp")
    if isinstance(ts, str):
        hit = re.match(r"\s*\d{4}-(\d{2})", ts)
        if hit and 1 <= int(hit.group(1)) <= 12:
            return int(hit.group(1))
    return None


def f32(x: float) -> float:
    """Round to a 32-bit float, as scikit-learn does with its inputs."""
    return struct.unpack("f", struct.pack("f", float(x)))[0]


def walk(nodes: list, x: list) -> float:
    i = 0
    while True:
        n = nodes[i]
        if len(n) == 1:
            return n[0]
        i = n[2] if x[n[0]] <= n[1] else n[3]


def mean(a):
    return sum(a) / len(a)


def sd(a):
    """Sample standard deviation (n - 1), the same as the website."""
    if len(a) < 2:
        return 0.0
    m = mean(a)
    return math.sqrt(sum((v - m) ** 2 for v in a) / (len(a) - 1))


class MedicineModel:
    def __init__(self, cid: str, p: dict, info: dict, season_table: dict = None):
        self.id = cid
        self.name = p["name"]
        self.unit = p["unit"]
        self.fac = p.get("ng_to_unit", 1e-3)
        self.feats = p["feats"]
        self.threshold = p["threshold"]            # "high" level in self.unit
        self.threshold_ngL = p["threshold_ngL"]
        self.p_threshold = p["p_threshold"]        # red line on P(high): send to lab
        self.p_amber = p.get("p_amber", self.p_threshold)   # amber line: watch
        self.kind = p.get("kind", "one-step")
        self.season = bool(p.get("season"))
        self.season_table = season_table or DEFAULT_SEASON
        self.rmse_log = p["level"]["rmse_log_cv"]
        self.ranges = p["ranges"]
        self.clf = p.get("clf_trees")
        self.det = p.get("det_trees")
        self.cond = p.get("cond_trees")
        self.reg = p["reg_trees"]
        self.meta = p
        self.info = info

    # ---- the two models
    def p_high(self, x32):
        if self.kind == "two-step":
            return mean([walk(t, x32) for t in self.det]) * mean([walk(t, x32) for t in self.cond])
        return mean([walk(t, x32) for t in self.clf])

    def alert(self, p):
        return "red" if p >= self.p_threshold else "amber" if p >= self.p_amber else "green"

    def log_levels(self, x32):
        return [walk(t, x32) for t in self.reg]

    def outside_range(self, x):
        out = []
        for f, v, (a, b) in zip(self.feats, x, self.ranges):
            pad = 0.1 * ((b - a) or abs(a) * 0.1 or 1)
            if v < a - pad or v > b + pad:
                out.append(f)
        return out

    def predict(self, readings: dict) -> dict:
        missing = [f for f in self.feats if readings.get(f) is None or not math.isfinite(readings[f])]
        base = {"compound": self.id, "name": self.name, "sensors_used": self.feats}
        if missing:
            return {**base, "ok": False, "missing": missing,
                    "message": "Needs " + ", ".join(SENSORS.get(f, f) for f in missing)}
        x = [float(readings[f]) for f in self.feats]
        x32 = [f32(v) for v in x]
        xs, month, assumed = x32, None, False
        if self.season:
            month = month_of(readings)
            if month is None:
                month, assumed = dt.datetime.now(dt.timezone.utc).month, True
            xs = x32 + [f32(self.season_table["m_sin"][month - 1]), f32(self.season_table["m_cos"][month - 1])]
        p = self.p_high(xs)
        logs = self.log_levels(x32)
        ml, sp = mean(logs), sd(logs)
        s = math.sqrt(sp * sp + self.rmse_log * self.rmse_log)
        auc = self.meta.get("screen_holdout", {}).get("auc", 0)
        conf = "High" if auc >= 0.85 else "Medium" if auc >= 0.7 else "Low"
        reasons = [f"screening ROC-AUC on rivers the model never saw is {auc:.2f}"]
        if assumed:
            reasons.append(f"no month given: used this month ({MONTHS[month - 1]})")
        outside = self.outside_range(x)
        if outside:
            conf = "Low"
            reasons.append("outside the range it was trained on: " + ", ".join(SENSORS.get(f, f) for f in outside))
        alert = self.alert(p)
        out = {
            **base, "ok": True,
            "p_high": round(p, 6),
            "alert": alert,
            "flag": alert == "red",
            "flag_line": round(self.p_threshold, 6),
            "amber_line": round(self.p_amber, 6),
            "verdict": VERDICT[alert],
            "model_kind": self.kind + (" + season" if self.season else ""),
            "screening_level": {"value": self.threshold, "unit": self.unit, "ng_per_L": self.threshold_ngL},
            "estimate": {"value": 10 ** ml * self.fac, "low": 10 ** (ml - 1.96 * s) * self.fac,
                         "high": 10 ** (ml + 1.96 * s) * self.fac, "unit": self.unit, "interval": "95%"},
            "confidence": conf,
            "reasons": reasons,
            "outside_range": outside,
        }
        if self.season:
            out["season_month"] = month
        return out

    def card(self) -> dict:
        m = self.meta
        return {
            "id": self.id, "name": self.name, "unit": self.unit,
            "class": self.info.get("cls"), "cas": self.info.get("cas"),
            "sensors": self.feats, "sensor_labels": [SENSORS.get(f, f) for f in self.feats],
            "high_above": {"value": self.threshold, "unit": self.unit, "ng_per_L": self.threshold_ngL},
            "flag_line": self.p_threshold,
            "amber_line": self.p_amber,
            "alert_rule": m.get("alert_rule", "flag = P(high) at or above the flag line"),
            "model_kind": self.kind + (" + season" if self.season else ""),
            "algorithm": ("Random forests (60 trees each): P(detected) x P(high if detected)" if self.kind == "two-step"
                          else "Random forest (60 trees): screening classifier") + (", season as an input" if self.season else "")
                         + " + level regressor",
            "chosen_settings": m.get("chosen"),
            "split": m.get("split"),
            "testing": m.get("screen_holdout"),
            "testing_amber": m.get("screen_holdout_amber"),
            "validation": m.get("screen_cv"),
            "training": m.get("screen_train"),
            "level_model": m.get("level"),
            "importance": m.get("importance"),
            "trained_ranges": dict(zip(self.feats, self.ranges)),
        }


class ModelPackage:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.raw = json.loads(self.path.read_text(encoding="utf-8"))
        if not str(self.raw.get("format", "")).startswith("aquatrace-model-package/"):
            raise ValueError(f"{path} is not an AquaTrace model package")
        info = {c["id"]: c for c in self.raw.get("compounds", [])}
        season = self.raw.get("season_table")
        self.models = {cid: MedicineModel(cid, p, info.get(cid, {}), season) for cid, p in self.raw["models"].items()}
        self.created = self.raw.get("created")
        self.summary = self.raw.get("summary", {})

    def predict(self, readings: dict, compounds=None) -> list:
        ids = compounds or list(self.models)
        unknown = [c for c in ids if c not in self.models]
        if unknown:
            raise KeyError(", ".join(unknown))
        return [self.models[c].predict(readings) for c in ids]
