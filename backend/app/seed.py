"""Seed the database.

    python -m app.seed --reference          # compounds + potential sources only (real deployments)
    python -m app.seed --demo --days 7      # + 7 days of SYNTHETIC readings, HPLC, reactor runs, survey

Demo rows are tagged origin="demo" so they can be removed later:  python -m app.seed --purge-demo
"""
from __future__ import annotations

import argparse
import math
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from . import config, pipeline
from .db import (Compound, Event, HplcResult, Interview, ModelVersion, ReactorRun, Reading, SessionLocal, Source,
                 SurveyResponse, init_db)
from .demo_world import COMPOUNDS, PLACES, SOURCES, STATIONS, World
from .services.core import dist_m

LOD = {"PCM": 0.005, "DIC": 0.054, "CBZ": 0.060, "ATL": 0.080, "KTP": 0.050}


def seed_reference(db):
    for c in COMPOUNDS:
        db.merge(Compound(**c))
    for s in SOURCES:
        db.merge(Source(**s))
    db.commit()


def seed_demo(db, days: int = 7, step_min: int = 5, device: str = "BOAT-01"):
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = now - timedelta(days=days)
    w = World(start, days=days + 2)
    rng = random.Random(7)
    truths = []
    ts = start
    while ts <= now:
        r, conc = w.sample(ts)
        pipeline.process_reading(db, r, device)
        truths.append((r, conc))
        ts += timedelta(minutes=step_min)
    # grab samples at stations, ≥90 min apart
    cand = [(r, c) for r, c in truths if any(dist_m(r["lat"], r["lon"], *PLACES[s]) < 60 for s in STATIONS)]
    rng.shuffle(cand); picks = []
    for r, c in cand:
        if len(picks) >= 72:
            break
        if all(abs((r["ts"] - p[0]["ts"]).total_seconds()) > 5400 for p in picks):
            picks.append((r, c))
    picks.sort(key=lambda p: p[0]["ts"])
    for i, (r, conc) in enumerate(picks):
        st = next(s for s in STATIONS if dist_m(r["lat"], r["lon"], *PLACES[s]) < 60)
        sid = f"S-{i + 1:03d}"
        comps = ["PCM"] + (["DIC", "CBZ"] if i % 9 < 5 else []) + (["ATL"] if i % 12 < 5 else []) + (["KTP"] if i % 5 == 0 else [])
        for c in comps:
            v = conc[c] * math.exp(0.08 * rng.gauss(0, 1)); below = v < LOD[c]
            db.merge(HplcResult(id=f"{sid}-{c}", sample_id=sid, ts=r["ts"] + timedelta(minutes=round(rng.gauss(0, 2))),
                                lat=round(r["lat"] + 5e-5 * rng.gauss(0, 1), 6), lon=round(r["lon"] + 5e-5 * rng.gauss(0, 1), 6),
                                compound=c, conc=float(f"{(LOD[c] / 2 if below else v):.4g}"), lod=LOD[c], below=below,
                                method=next(x["method"] for x in COMPOUNDS if x["id"] == c), notes="demo", origin="demo", station=st))
    db.commit()
    # reactor runs (synthetic, paracetamol)
    def run(id, cat, dose, light, k, hours, ads, rep=None):
        rows, C0, t = [], 5.0, 0.0
        active = cat != "none" and light != "dark"
        while t <= hours + 1e-9:
            adsf = 1 - ads * (1 - math.exp(-t * 4)) if ads else 1
            C = C0 * adsf * math.exp(-k * t) * (math.exp(0.03 * rng.gauss(0, 1)) if t else 1); f = C / C0
            rows.append(dict(time_h=round(t, 2), conc=round(C, 4),
                             uv=round(0.05 + 0.6 * f + 0.22 * (1 - f) * math.exp(-t / 1.8) + (0.04 if dose else 0), 4),
                             orp=round(245 + (120 * (1 - math.exp(-t / 1.2)) if active else 8 * t), 1),
                             ph=round(6.9 - (0.45 * (1 - math.exp(-t / 1.5)) if active else 0.02 * t), 3),
                             turbidity=round(dose * 180 + 3, 1), toc=round(4.1 * (1 - (0.33 * (1 - math.exp(-t / 2.2)) if active else 0.02 * t)), 3)))
            t += 0.5
        db.merge(ReactorRun(id=id, catalyst=cat, dose=dose, light=light, compound="PCM", rows=rows, origin="demo", rep=rep))
    for a in [("R1", "Fe2O3-TiO2", 0.2, "simulated solar", 1.02, 3, 0.06), ("R1b", "Fe2O3-TiO2", 0.2, "simulated solar", 0.97, 3, 0.06, "R1"),
              ("R2", "TiO2 P25", 0.2, "simulated solar", 0.71, 3, 0.04), ("R3", "Fe2O3-TiO2", 0.1, "simulated solar", 0.78, 3, 0.04),
              ("R4", "Fe2O3-TiO2", 0.3, "simulated solar", 0.86, 3, 0.07), ("R5", "Fe2O3-TiO2", 0.2, "natural solar (pilot)", 0.44, 5, 0.05),
              ("C1", "none", 0, "simulated solar", 0.045, 3, 0), ("C2", "Fe2O3-TiO2", 0.2, "dark", 0.0, 3, 0.08)]:
        run(*a)
    methods = [("Household rubbish bin", 46), ("Kept at home", 22), ("Returned to pharmacy / clinic", 14), ("Sink or toilet", 9), ("Given to family or friends", 6), ("Other", 3)]
    for i in range(120):
        u = rng.random() * 100; m = methods[0][0]
        for k, p in methods:
            if u < p:
                m = k; break
            u -= p
        f = lambda b: min(5, max(1, round(b + rng.gauss(0, 0.9))))
        db.add(SurveyResponse(respondent_id=f"D{i + 1}", disposal_method=m, origin="demo",
                              answers=dict(awareness=f(3.9), convenience=f(3.6), uncertainty=f(3.4), habit=f(3.2), no_followup=f(3.0), leftover=f(3.8))))
    for th, tx in [("Convenience", "Example: nearest take-back point is a hospital pharmacy; respondents rarely pass it."),
                   ("Awareness", "Example: several respondents did not know clinics accept returned medicines."),
                   ("Leftover", "Example: symptom relief before the course ends leaves partial strips of tablets.")]:
        db.add(Interview(theme=th, text=tx, origin="demo"))
    db.commit()
    # train initial models, then re-score history so statuses reflect them
    for c in ["PCM", "DIC", "CBZ", "ATL", "KTP"]:
        try:
            mv = pipeline.train_compound(db, c, "rf")
            print(f"trained {c} v{mv.version}: CV R² {mv.metrics['r2_cv']:.2f} (n={mv.metrics['n']})")
        except ValueError as e:
            print(f"skip {c}: {e}")
    rescore(db)


def rescore(db):
    """Re-run baseline, estimates, status and events over stored readings (after training or threshold changes)."""
    pipeline.BASELINE.state.clear()
    db.execute(delete(Event))
    from .services.core import status_for
    tgt = db.get(Compound, config.TARGET_COMPOUND)
    from .services import ml
    from .services.core import add_time_features
    rows = list(db.scalars(select(Reading).order_by(Reading.ts)))
    dicts = [pipeline.reading_dict(r) for r in rows]
    feats = [add_time_features({k: d[k] for k in config.SENSOR_FIELDS if d[k] is not None}, d["ts"], d["lat"], d["lon"]) for d in dicts]
    ests = {c: ml.predict_batch(b, feats) for c, b in pipeline.MODELS.items()}
    for i, (r, d) in enumerate(zip(rows, dicts)):
        r.zone, r.z = pipeline.BASELINE.score(r.device, d)
        r.est = {c: e[i] for c, e in ests.items() if e[i]}
        r.status = status_for(r.z, r.est.get(config.TARGET_COMPOUND), tgt.level if tgt else None)
        if r.status != "ok":
            pipeline.update_events(db, r)
    db.execute(Event.__table__.update().values(notified=True))   # history does not trigger webhooks
    db.commit()


def purge_demo(db):
    for model in (HplcResult, ReactorRun, SurveyResponse, Interview):
        db.execute(delete(model).where(model.origin == "demo"))
    db.execute(delete(Reading).where(Reading.device == "BOAT-01"))
    db.execute(delete(Event)); db.execute(delete(ModelVersion))
    db.commit()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", action="store_true"); ap.add_argument("--demo", action="store_true")
    ap.add_argument("--days", type=int, default=7); ap.add_argument("--purge-demo", action="store_true")
    a = ap.parse_args()
    init_db()
    with SessionLocal() as db:
        if a.purge_demo:
            purge_demo(db); print("demo data removed")
        if a.reference or a.demo:
            seed_reference(db); print("reference data loaded")
        if a.demo:
            pipeline.load_active_models(db)
            seed_demo(db, a.days); print("demo data loaded")
