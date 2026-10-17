"""Ingest pipeline: every reading is scored, estimated and grouped into events as it arrives,
so alerts are raised even when nobody has the dashboard open."""
from __future__ import annotations

import logging
import threading
from datetime import timedelta

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config
from .db import Compound, Event, HplcResult, ModelVersion, Reading, Source
from .services import integrations, ml, osm
from .services.core import Baseline, add_time_features, aware, dist_m, match_sample, parse_ts, status_for

log = logging.getLogger("aquatrace.pipeline")
_lock = threading.Lock()
BASELINE = Baseline()
MODELS: dict[str, dict] = {}      # compound -> loaded bundle (active version)


def load_active_models(db: Session):
    MODELS.clear()
    for mv in db.scalars(select(ModelVersion).where(ModelVersion.active.is_(True))):
        try:
            b = ml.load(mv.path); b["version"] = mv.version; MODELS[mv.compound] = b
        except Exception as e:
            log.warning("could not load model %s v%s: %s", mv.compound, mv.version, e)


def warm_baseline(db: Session, hours: int = 24):
    """Rebuild in-memory baselines from recent history after a restart."""
    last = db.scalar(select(Reading.ts).order_by(Reading.ts.desc()).limit(1))
    if not last:
        return
    for r in db.scalars(select(Reading).where(Reading.ts >= aware(last) - timedelta(hours=hours)).order_by(Reading.ts)):
        BASELINE.score(r.device, reading_dict(r))


def reading_dict(r: Reading) -> dict:
    return {"id": r.id, "ts": aware(r.ts), "device": r.device, "lat": r.lat, "lon": r.lon,
            **{k: getattr(r, k) for k in config.SENSOR_FIELDS}, "status": r.status, "zone": r.zone}


def estimate(ts, lat, lon, sensors: dict) -> dict:
    feats = add_time_features(sensors, ts, lat, lon)
    out = {}
    for comp, bundle in MODELS.items():
        e = ml.predict(bundle, feats)
        if e:
            out[comp] = e
    return out


def process_reading(db: Session, payload: dict, device: str, notify_async=None) -> Reading:
    with _lock:
        ts = parse_ts(payload["ts"]) if payload.get("ts") else None
        if ts is None:
            from .db import utcnow
            ts = utcnow()
        vals = {k: (float(payload[k]) if payload.get(k) is not None else None) for k in config.SENSOR_FIELDS}
        zone, z = BASELINE.score(device, vals)
        est = estimate(ts, payload["lat"], payload["lon"], {k: v for k, v in vals.items() if v is not None})
        target = db.get(Compound, config.TARGET_COMPOUND)
        st = status_for(z, est.get(config.TARGET_COMPOUND), target.level if target else None)
        extra = {k: v for k, v in payload.items() if k not in {"ts", "lat", "lon", "device", *config.SENSOR_FIELDS}}
        r = Reading(device=device, ts=ts, lat=float(payload["lat"]), lon=float(payload["lon"]), **vals,
                    extra=extra, zone=zone, z=z, est=est, status=st)
        db.add(r)
        ev = update_events(db, r) if st != "ok" else None
        db.commit()
        if ev is not None and ev.status == "bad" and not ev.notified and notify_async:
            notify_async(ev.id)
        return r


def update_events(db: Session, r: Reading) -> Event:
    gap = timedelta(minutes=config.EVENT_GAP_MIN)
    ev = db.scalar(select(Event).where(Event.device == r.device).order_by(Event.end.desc()).limit(1))
    est = (r.est or {}).get(config.TARGET_COMPOUND) or {}
    if ev is None or aware(r.ts) - aware(ev.end) > gap:
        near = min(((s, dist_m(r.lat, r.lon, s.lat, s.lon)) for s in db.scalars(select(Source))), key=lambda x: x[1], default=(None, None))
        ev = Event(device=r.device, start=r.ts, end=r.ts, status=r.status, n=0, lat=r.lat, lon=r.lon, compound=config.TARGET_COMPOUND,
                   peak_est=est.get("mu"), peak_conf=est.get("conf"), drivers=_drivers(r.z),
                   nearest_source=near[0].name if near[0] else None, source_dist_m=near[1])
        db.add(ev)
    ev.end = r.ts; ev.n = (ev.n or 0) + 1
    if r.status == "bad":
        ev.status = "bad"
    if est.get("mu") is not None and (ev.peak_est is None or est["mu"] > ev.peak_est):
        ev.peak_est, ev.peak_conf, ev.lat, ev.lon, ev.drivers = est["mu"], est.get("conf"), r.lat, r.lon, _drivers(r.z)
        near = min(((s, dist_m(r.lat, r.lon, s.lat, s.lon)) for s in db.scalars(select(Source))), key=lambda x: x[1], default=(None, None))
        if near[0]:
            ev.nearest_source, ev.source_dist_m = near[0].name, near[1]
    db.flush()
    return ev


def _drivers(z: dict) -> list[dict]:
    return sorted(({"k": k, "z": v} for k, v in (z or {}).items()), key=lambda d: -abs(d["z"]))[:4]


def enrich_and_notify(event_id: int):
    """Background task: attach weather context and send the webhook once per event."""
    from .db import SessionLocal
    with SessionLocal() as db:
        ev = db.get(Event, event_id)
        if not ev or ev.notified:
            return
        ev.weather = integrations.weather_context(ev.lat, ev.lon, aware(ev.start))
        ev.place = osm.reverse(ev.lat, ev.lon)
        ev.notified = integrations.notify({"device": ev.device, "lat": ev.lat, "lon": ev.lon, "compound": ev.compound,
                                           "peak_est": ev.peak_est or 0, "peak_conf": ev.peak_conf, "drivers": ev.drivers or [{"k": "-", "z": 0}],
                                           "nearest_source": ev.nearest_source, "source_dist_m": ev.source_dist_m or 0,
                                           "place": (ev.place or {}).get("short")}) or True
        db.commit()


# ---------------------------------------------------------------- training
def paired_dataset(db: Session, compound: str, win_min=config.MATCH_WINDOW_MIN, dist_max=config.MATCH_DIST_M):
    rows = []
    for h in db.scalars(select(HplcResult).where(HplcResult.compound == compound).order_by(HplcResult.ts)):
        ts = aware(h.ts)
        near = [reading_dict(r) for r in db.scalars(select(Reading).where(Reading.ts >= ts - timedelta(minutes=win_min), Reading.ts <= ts + timedelta(minutes=win_min)))]
        m = match_sample({"ts": ts, "lat": h.lat, "lon": h.lon, "sensors": h.sensors}, near, win_min, dist_max)
        rows.append((h, m))
    return rows


def train_compound(db: Session, compound: str, algo: str = "rf", features: list[str] | None = None, by_station: bool = False) -> ModelVersion:
    features = features or ml.DEFAULT_FEATURES
    pairs = [(h, m) for h, m in paired_dataset(db, compound) if m["ok"]]
    X, y, groups = [], [], []
    for h, m in pairs:
        f = add_time_features(m["sensors"], h.ts, h.lat, h.lon)
        X.append([f.get(k, np.nan) for k in features]); y.append(h.conc); groups.append(h.station or f"{h.lat:.3f},{h.lon:.3f}")
    X, y = np.array(X, dtype=float), np.array(y, dtype=float)
    keep = ~np.isnan(X).any(axis=1)
    bundle = ml.train(X[keep], y[keep], features, algo, groups=np.array(groups)[keep] if by_station else None)
    last = db.scalar(select(ModelVersion.version).where(ModelVersion.compound == compound).order_by(ModelVersion.version.desc()).limit(1)) or 0
    for mv in db.scalars(select(ModelVersion).where(ModelVersion.compound == compound, ModelVersion.active.is_(True))):
        mv.active = False
    path = ml.save(bundle, compound, last + 1)
    mv = ModelVersion(compound=compound, version=last + 1, algo=algo, features=features, metrics=bundle["metrics"], path=path, active=True)
    db.add(mv); db.commit()
    bundle["version"] = mv.version
    MODELS[compound] = bundle
    return mv
