"""AquaTrace model engine: runs the model package exported by the Colab notebook.

The package holds, for each medicine, two random forests as plain arrays:
  - a screening classifier: probability that the medicine is above the "high" level
  - a level regressor: log10 concentration (ng/L) when the medicine is present
Each tree is a list of nodes: [feature, threshold, left, right] for a split, [value] for a leaf.

The split rule is scikit-learn's: inputs are rounded to 32-bit floats, then x <= threshold goes left.
So this file gives the same numbers as the Colab notebook and the website, with no scikit-learn needed.
"""
import json
import math
import struct
from pathlib import Path

SENSORS = {
    "ph": "pH",
    "temp": "Temperature (°C)",
    "conductivity": "Conductivity (µS/cm)",
    "turbidity": "Turbidity (NTU)",
    "do": "Dissolved oxygen (mg/L)",
}


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
    def __init__(self, cid: str, p: dict, info: dict):
        self.id = cid
        self.name = p["name"]
        self.unit = p["unit"]
        self.fac = p.get("ng_to_unit", 1e-3)
        self.feats = p["feats"]
        self.threshold = p["threshold"]            # "high" level in self.unit
        self.threshold_ngL = p["threshold_ngL"]
        self.p_threshold = p["p_threshold"]        # flag line on P(high)
        self.rmse_log = p["level"]["rmse_log_cv"]
        self.ranges = p["ranges"]
        self.clf = p["clf_trees"]
        self.reg = p["reg_trees"]
        self.meta = p
        self.info = info

    # ---- the two models
    def p_high(self, x32):
        return mean([walk(t, x32) for t in self.clf])

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
        p = self.p_high(x32)
        logs = self.log_levels(x32)
        ml, sp = mean(logs), sd(logs)
        s = math.sqrt(sp * sp + self.rmse_log * self.rmse_log)
        auc = self.meta.get("screen_holdout", {}).get("auc", 0)
        conf = "High" if auc >= 0.85 else "Medium" if auc >= 0.7 else "Low"
        reasons = [f"screening ROC-AUC on rivers the model never saw is {auc:.2f}"]
        outside = self.outside_range(x)
        if outside:
            conf = "Low"
            reasons.append("outside the range it was trained on: " + ", ".join(SENSORS.get(f, f) for f in outside))
        flag = p >= self.p_threshold
        return {
            **base, "ok": True,
            "p_high": round(p, 6),
            "flag": flag,
            "flag_line": round(self.p_threshold, 6),
            "verdict": "Send this sample to the lab" if flag else "No lab test needed",
            "screening_level": {"value": self.threshold, "unit": self.unit, "ng_per_L": self.threshold_ngL},
            "estimate": {"value": 10 ** ml * self.fac, "low": 10 ** (ml - 1.96 * s) * self.fac,
                         "high": 10 ** (ml + 1.96 * s) * self.fac, "unit": self.unit, "interval": "95%"},
            "confidence": conf,
            "reasons": reasons,
            "outside_range": outside,
        }

    def card(self) -> dict:
        m = self.meta
        return {
            "id": self.id, "name": self.name, "unit": self.unit,
            "class": self.info.get("cls"), "cas": self.info.get("cas"),
            "sensors": self.feats, "sensor_labels": [SENSORS.get(f, f) for f in self.feats],
            "high_above": {"value": self.threshold, "unit": self.unit, "ng_per_L": self.threshold_ngL},
            "flag_line": self.p_threshold,
            "algorithm": "Random forest (60 trees): screening classifier + level regressor",
            "chosen_settings": m.get("chosen"),
            "split": m.get("split"),
            "testing": m.get("screen_holdout"),
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
        self.models = {cid: MedicineModel(cid, p, info.get(cid, {})) for cid, p in self.raw["models"].items()}
        self.created = self.raw.get("created")
        self.summary = self.raw.get("summary", {})

    def predict(self, readings: dict, compounds=None) -> list:
        ids = compounds or list(self.models)
        unknown = [c for c in ids if c not in self.models]
        if unknown:
            raise KeyError(", ".join(unknown))
        return [self.models[c].predict(readings) for c in ids]
