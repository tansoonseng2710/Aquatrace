"""Checks for the AquaTrace ML API.   Run:  python test_api.py

1. Every endpoint answers.
2. The online model reproduces the testing-set scores from the Colab notebook exactly:
   it re-scores every testing-set lab result in crosscheck_lab_results.csv and recomputes
   ROC-AUC and the confusion matrix for each medicine.
"""
import csv
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app import PKG, app

c = TestClient(app)
HERE = Path(__file__).parent
CROSS = next((p for p in [HERE / "crosscheck_lab_results.csv", HERE.parent / "frontend" / "models" / "crosscheck_lab_results.csv"] if p.exists()), None)


def auc(pos, neg):
    s = 0.0
    for v in pos:
        s += sum(1.0 if v > w else 0.5 if v == w else 0.0 for w in neg)
    return s / (len(pos) * len(neg))


ok = True
for path in ["/", "/health", "/models", "/models/ATL-US", "/evaluation", "/model-package"]:
    r = c.get(path)
    print(f"GET {path:16s} {r.status_code}")
    ok &= r.status_code == 200

r = c.post("/predict", json={"readings": {"ph": 7.6, "temp": 24, "conductivity": 950, "turbidity": 8.5, "do": 6.2}})
print("POST /predict", r.status_code, [(x["compound"], x.get("p_high"), x.get("flag")) for x in r.json()["results"]])
ok &= r.status_code == 200 and all(x["ok"] for x in r.json()["results"])
r = c.post("/predict", json={"readings": {"ph": 7.6}, "compounds": ["CBZ-US"]})
print("POST /predict (missing sensors)", r.json()["results"][0]["message"])
ok &= c.post("/predict", json={"readings": {"ph": 7}, "compounds": ["XYZ"]}).status_code == 404

if CROSS:
    rows = list(csv.DictReader(open(CROSS, encoding="utf-8")))
    print(f"\nRe-scoring {len(rows):,} testing-set lab results through POST /predict/batch")
    for cid, m in PKG.models.items():
        R = [x for x in rows if x["compound"] == cid]
        items = [{f: (float(x[f]) if x[f] != "" else None) for f in m.feats} for x in R]
        out = c.post("/predict/batch", json={"items": items, "compounds": [cid]}).json()["results"]
        p = [o[0]["p_high"] for o in out]
        flag = [o[0]["flag"] for o in out]
        high = [x["concentration"] != "<LOD" and float(x["concentration"]) >= m.threshold for x in R]
        a = auc([v for v, h in zip(p, high) if h], [v for v, h in zip(p, high) if not h])
        tp = sum(f and h for f, h in zip(flag, high)); fp = sum(f and not h for f, h in zip(flag, high))
        fn = sum(h and not f for f, h in zip(flag, high)); tn = len(R) - tp - fp - fn
        ref = m.meta["screen_holdout"]
        same = round(a, 3) == ref["auc"] and [tp, fp, fn, tn] == [int(ref[k]) for k in ("tp", "fp", "fn", "tn")]
        ok &= same
        print(f"  {cid}: AUC {a:.3f} (Colab {ref['auc']:.3f}) · TP/FP/FN/TN {tp}/{fp}/{fn}/{tn} "
              f"(Colab {int(ref['tp'])}/{int(ref['fp'])}/{int(ref['fn'])}/{int(ref['tn'])}) {'✓ same' if same else '✗ DIFFERENT'}")
else:
    print("crosscheck_lab_results.csv not found: skipped the exactness check")

print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED")
sys.exit(0 if ok else 1)
