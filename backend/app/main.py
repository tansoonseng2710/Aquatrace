"""AquaTrace API: sensor ingest, HPLC reference data, ML training, events, reactor and survey data.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import config, pipeline
from .db import (Compound, Event, HplcResult, Interview, ModelVersion, ReactorRun, Reading, SamplingRequest, SessionLocal,
                 Source, SurveyResponse, init_db)
from .literature import literature
from .services import integrations, osm
from .services.core import aware, convert, kinetics, parse_ts, reactor_verdict

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("aquatrace")
@asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app = FastAPI(title="AquaTrace API", version=config.VERSION, lifespan=lifespan,
              description="Real-time water-quality sensing + HPLC reference data + ML screening for pharmaceutical micropollutants. "
                          "ML outputs are screening estimates, not laboratory measurements.")
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_key(x_api_key: Optional[str] = Header(None)):
    if config.API_KEY and x_api_key != config.API_KEY:
        raise HTTPException(401, "Missing or wrong X-API-Key header.")


def device_auth(device: str, key: Optional[str]):
    if config.DEVICE_KEYS and config.DEVICE_KEYS.get(device) != key and not (config.API_KEY and key == config.API_KEY):
        raise HTTPException(401, f"Device '{device}' is not registered or its key is wrong.")


def startup():
    init_db()
    with SessionLocal() as db:
        if not db.scalar(select(Compound).limit(1)):
            from .seed import seed_reference
            seed_reference(db)
            log.info("reference compounds and sources loaded")
        pipeline.load_active_models(db)
        pipeline.warm_baseline(db)
    if config.MQTT_HOST:
        from .mqtt import start_mqtt
        threading.Thread(target=start_mqtt, daemon=True).start()


# ------------------------------------------------------------------ schemas
class ReadingIn(BaseModel):
    device: Optional[str] = None
    ts: Optional[str] = Field(None, description="ISO 8601; server time is used if missing")
    lat: float; lon: float
    ph: Optional[float] = None; orp: Optional[float] = None; turbidity: Optional[float] = None; uv: Optional[float] = None
    temp: Optional[float] = None; conductivity: Optional[float] = None; do: Optional[float] = None
    model_config = {"extra": "allow"}


class HplcIn(BaseModel):
    id: Optional[str] = None; sample_id: str; ts: str; lat: float; lon: float; compound: str
    conc: float; lod: Optional[float] = None; below: bool = False; method: str = ""; notes: str = ""; origin: str = "upload"
    sensors: Optional[dict] = None; station: Optional[str] = None


class CompoundIn(BaseModel):
    id: str; name: str; cls: str = ""; cas: str = ""; kow: Optional[float] = None; unit: str = "µg/L"
    level: Optional[float] = None; pnec: Optional[float] = None; bg: float = 0; method: str = ""; rt: Optional[float] = None; src: str = ""


class TrainIn(BaseModel):
    compound: str; model: str = "rf"; features: Optional[list[str]] = None
    by_station: bool = Field(False, description="GroupKFold by station: tests transfer to unseen locations")


# ------------------------------------------------------------------ helpers
def ser_reading(r: Reading) -> dict:
    return {"id": r.id, "ts": aware(r.ts).isoformat(), "device": r.device, "lat": r.lat, "lon": r.lon,
            **{k: getattr(r, k) for k in config.SENSOR_FIELDS}, "status": r.status, "zone": r.zone, "est": r.est, "z": r.z,
            "extra": {k: v for k, v in (r.extra or {}).items() if k in DEVICE_META}}


DEVICE_META = {"name", "mode", "battery", "acc", "net", "discharge", "heading", "seq", "hdop", "sats", "speed_kn",
               "kind", "fw", "ph_mv", "turb_mv", "turb_cal", "rssi", "uptime_s", "every_s", "cal", "ack", "vcc_mv", "via"}


def ser_hplc(h: HplcResult) -> dict:
    return {"id": h.id, "sample_id": h.sample_id, "ts": aware(h.ts).isoformat(), "lat": h.lat, "lon": h.lon, "compound": h.compound,
            "conc": h.conc, "lod": h.lod, "below": h.below, "method": h.method, "notes": h.notes, "origin": h.origin,
            "sensors": h.sensors, "station": h.station}


def row_to_dict(o) -> dict:
    return {c.name: getattr(o, c.name) for c in o.__table__.columns}


# ------------------------------------------------------------------ core
@app.get("/api/health")
def health():
    return {"status": "ok", "name": "AquaTrace API", "version": config.VERSION, "map": map_config(), "models": {c: b.get("version") for c, b in pipeline.MODELS.items()}}


@app.get("/api/bootstrap")
def bootstrap(db: Session = Depends(get_db)):
    """Everything the dashboard needs except readings."""
    return {
        "compounds": [row_to_dict(c) for c in db.scalars(select(Compound))],
        "sources": [row_to_dict(s) for s in db.scalars(select(Source))],
        "hplc": [ser_hplc(h) for h in db.scalars(select(HplcResult).order_by(HplcResult.ts))],
        "reactor_runs": [row_to_dict(r) for r in db.scalars(select(ReactorRun))],
        "survey": [{"respondent_id": s.respondent_id, "disposal_method": s.disposal_method, "origin": s.origin, **(s.answers or {})} for s in db.scalars(select(SurveyResponse))],
        "interviews": [row_to_dict(i) for i in db.scalars(select(Interview).order_by(Interview.id.desc()))],
        "literature": literature(),
        "map": map_config(),
    }


def map_config():
    return {"tile_url": config.OSM_TILE_URL, "attribution": config.OSM_TILE_ATTRIBUTION, "osm_enabled": config.ENABLE_OSM}


@app.get("/api/literature")
def literature_mec():
    """Measured concentrations from prior USM studies (reference context, never used for training)."""
    return literature()


@app.post("/api/ingest", status_code=201)
def ingest(body: ReadingIn | list[ReadingIn], bg: BackgroundTasks, x_api_key: Optional[str] = Header(None),
           x_device_id: Optional[str] = Header(None), db: Session = Depends(get_db)):
    """Sensor node endpoint. One reading or a batch (e.g. after a connectivity gap)."""
    items = body if isinstance(body, list) else [body]
    out = []
    for it in items:
        device = it.device or x_device_id or "UNKNOWN"
        device_auth(device, x_api_key)
        r = pipeline.process_reading(db, it.model_dump(), device, notify_async=lambda eid: bg.add_task(pipeline.enrich_and_notify, eid))
        out.append({"id": r.id, "status": r.status, "est": r.est})
    return out if isinstance(body, list) else out[0]


@app.get("/api/readings")
def readings(hours: float = 24, since: Optional[str] = None, device: str = "", max_points: int = 6000, db: Session = Depends(get_db)):
    q = select(Reading).order_by(Reading.ts)
    q = q.where(Reading.ts > parse_ts(since)) if since else q.where(Reading.ts >= datetime.now(timezone.utc) - timedelta(hours=hours))
    if device:
        q = q.where(Reading.device == device)
    rows = list(db.scalars(q))
    if len(rows) > max_points:           # stride-thin long histories; never drop abnormal readings
        step = len(rows) / max_points
        keep = {int(i * step) for i in range(max_points)}
        rows = [r for i, r in enumerate(rows) if i in keep or r.status != "ok"]
    return [ser_reading(r) for r in rows]


@app.get("/api/devices")
def devices(hours: float = 24, db: Session = Depends(get_db)):
    """Fleet overview: every device that reported in the window, with its latest position, status and phone details."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.execute(select(Reading.device, func.count(Reading.id), func.max(Reading.ts)).where(Reading.ts >= since).group_by(Reading.device)).all()
    out = []
    for dev, n, last_ts in rows:
        r = db.scalar(select(Reading).where(Reading.device == dev, Reading.ts == last_ts).limit(1))
        if not r:
            continue
        meta = {k: v for k, v in (r.extra or {}).items() if k in DEVICE_META}
        bad = db.scalar(select(func.count(Reading.id)).where(Reading.device == dev, Reading.ts >= datetime.now(timezone.utc) - timedelta(hours=1), Reading.status == "bad"))
        out.append({"device": dev, "name": meta.get("name") or dev, "readings": n, "last_ts": aware(last_ts).isoformat(), "lat": r.lat, "lon": r.lon,
                    "status": r.status, "flagged_readings_last_hour": bad, "meta": meta})
    return sorted(out, key=lambda d: d["last_ts"], reverse=True)


@app.get("/api/readings/latest")
def latest(device: str = "", db: Session = Depends(get_db)):
    q = select(Reading).order_by(Reading.ts.desc()).limit(1)
    if device:
        q = q.where(Reading.device == device)
    r = db.scalar(q)
    if not r:
        raise HTTPException(404, "No readings yet.")
    return ser_reading(r)


# ------------------------------------------------------------------ HPLC
@app.post("/api/hplc", dependencies=[Depends(require_key)])
def add_hplc(items: list[HplcIn], db: Session = Depends(get_db)):
    for h in items:
        if not db.get(Compound, h.compound):
            raise HTTPException(422, f"Unknown compound '{h.compound}'. Add it with POST /api/compounds first.")
        d = h.model_dump(); d["ts"] = parse_ts(h.ts); d["id"] = h.id or f"{h.sample_id}-{h.compound}-{int(d['ts'].timestamp())}"
        db.merge(HplcResult(**d))
    db.commit()
    return {"saved": len(items)}


@app.post("/api/hplc/csv", dependencies=[Depends(require_key)])
async def add_hplc_csv(request: Request, db: Session = Depends(get_db)):
    """Raw CSV body. Columns: sample_id,timestamp,lat,lon,compound,concentration,unit,lod,method,notes[,ph,orp,...]"""
    text = (await request.body()).decode("utf-8-sig")
    comps = {c.id.lower(): c for c in db.scalars(select(Compound))} | {c.name.lower(): c for c in db.scalars(select(Compound))}
    saved, errors = 0, []
    for i, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        c = comps.get(row.get("compound", "").lower())
        if not c:
            errors.append(f"row {i}: unknown compound '{row.get('compound')}'"); continue
        try:
            ts = parse_ts(row["timestamp"]); unit = row.get("unit") or c.unit
            lod = convert(float(row["lod"]), unit, c.unit) if row.get("lod") else None
            below = any(t in row["concentration"].lower() for t in ("<", "lod", "nd"))
            conc = lod / 2 if below else convert(float(row["concentration"]), unit, c.unit)
            if conc is None:
                raise ValueError(f"unit '{unit}' not recognised")
            sensors = {k: float(row[k]) for k in config.SENSOR_FIELDS if row.get(k)}
            db.merge(HplcResult(id=f"{row.get('sample_id') or 'U'}-{c.id}-{int(ts.timestamp())}", sample_id=row.get("sample_id") or "(no id)",
                                ts=ts, lat=float(row["lat"]), lon=float(row["lon"]), compound=c.id, conc=conc, lod=lod, below=below,
                                method=row.get("method", ""), notes=row.get("notes", ""), origin="upload",
                                sensors=sensors if len(sensors) == len(config.SENSOR_FIELDS) else None))
            saved += 1
        except Exception as e:
            errors.append(f"row {i}: {e}")
    db.commit()
    return {"saved": saved, "errors": errors}


@app.get("/api/pairs")
def pairs(compound: str, db: Session = Depends(get_db)):
    """Paired dataset (HPLC result + matched sensor values) used for training."""
    out = []
    for h, m in pipeline.paired_dataset(db, compound):
        out.append({**ser_hplc(h), "match": m})
    return out


# ------------------------------------------------------------------ compounds
@app.post("/api/compounds", dependencies=[Depends(require_key)])
def upsert_compound(c: CompoundIn, db: Session = Depends(get_db)):
    db.merge(Compound(**c.model_dump())); db.commit()
    return {"saved": c.id}


# ------------------------------------------------------------------ ML
@app.post("/api/ml/train", dependencies=[Depends(require_key)])
def train(body: TrainIn, db: Session = Depends(get_db)):
    try:
        mv = pipeline.train_compound(db, body.compound, body.model, body.features, body.by_station)
    except ValueError as e:
        raise HTTPException(422, str(e))
    m = mv.metrics
    return {"compound": mv.compound, "version": mv.version, "algo": mv.algo, "features": mv.features, "n": m["n"],
            "r2_cv": m["r2_cv"], "rmse": m["rmse"], "mae": m["mae"], "r2_uv_only": m["r2_uv_only"], "cv": m["cv"], "importance": m["importance"]}


@app.get("/api/ml/models")
def models(db: Session = Depends(get_db)):
    return [{**{k: v for k, v in row_to_dict(m).items() if k != "metrics"}, "metrics": {k: v for k, v in (m.metrics or {}).items() if k != "oof"}}
            for m in db.scalars(select(ModelVersion).order_by(ModelVersion.compound, ModelVersion.version.desc()))]


@app.get("/api/ml/estimate/latest")
def estimate_latest(device: str = "", db: Session = Depends(get_db)):
    r = latest(device, db)
    return {"reading": r, "estimates": r["est"], "note": "Screening estimate, not a laboratory measurement. Confirm with HPLC."}


# ------------------------------------------------------------------ events
@app.get("/api/events")
def events(hours: float = 168, db: Session = Depends(get_db)):
    q = select(Event).where(Event.start >= datetime.now(timezone.utc) - timedelta(hours=hours)).order_by(Event.start.desc())
    return [{**row_to_dict(e), "start": aware(e.start).isoformat(), "end": aware(e.end).isoformat()} for e in db.scalars(q)]


class SamplingIn(BaseModel):
    event_id: str; lat: float; lon: float; compound: str; note: str = ""


@app.post("/api/sampling-requests", dependencies=[Depends(require_key)])
def sampling(s: SamplingIn, db: Session = Depends(get_db)):
    sr = SamplingRequest(**s.model_dump()); db.add(sr); db.commit()
    return {"id": sr.id}


@app.get("/api/sampling-requests")
def sampling_list(db: Session = Depends(get_db)):
    return [row_to_dict(s) for s in db.scalars(select(SamplingRequest).order_by(SamplingRequest.id.desc()))]


# ------------------------------------------------------------------ reactor, survey, context
@app.post("/api/reactor/runs", dependencies=[Depends(require_key)])
def reactor_runs(runs: list[dict[str, Any]], db: Session = Depends(get_db)):
    for r in runs:
        db.merge(ReactorRun(id=str(r["id"]), catalyst=r.get("catalyst"), dose=r.get("dose"), light=r.get("light"),
                            compound=r.get("compound", "PCM"), rows=r["rows"], origin=r.get("origin", "upload"), rep=r.get("rep")))
    db.commit()
    return {"saved": len(runs)}


@app.get("/api/reactor/runs/{run_id}/assessment")
def reactor_assessment(run_id: str, db: Session = Depends(get_db)):
    run = db.get(ReactorRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    allr = [row_to_dict(r) for r in db.scalars(select(ReactorRun).where(ReactorRun.compound == run.compound))]
    ctrls = [r for r in allr if r["catalyst"] == "none" or r["light"] == "dark"]
    reps = [r for r in allr if r["id"] != run_id and (r["rep"] == run_id or (run.rep and r["id"] == run.rep))]
    return reactor_verdict(row_to_dict(run), ctrls, reps)


@app.post("/api/survey", dependencies=[Depends(require_key)])
def survey(rows: list[dict[str, Any]], db: Session = Depends(get_db)):
    from sqlalchemy import delete
    db.execute(delete(SurveyResponse).where(SurveyResponse.origin == "demo"))
    for r in rows:
        db.add(SurveyResponse(respondent_id=r.get("respondent_id"), disposal_method=r.get("disposal_method"), origin="upload",
                              answers={k: v for k, v in r.items() if k not in ("respondent_id", "disposal_method", "origin")}))
    db.commit()
    return {"saved": len(rows)}


@app.post("/api/interviews", dependencies=[Depends(require_key)])
def interview(it: dict[str, Any], db: Session = Depends(get_db)):
    db.add(Interview(theme=it.get("theme"), text=it.get("text"), origin="user")); db.commit()
    return {"saved": 1}


class SourceIn(BaseModel):
    id: Optional[str] = None; name: str; type: str; lat: float; lon: float; basis: str = ""; sigma: float = 250; load: float = 1.0
    lbl: Optional[str] = Field(None, description="label position on the map: right (default), left or above")


@app.post("/api/sources", dependencies=[Depends(require_key)])
def add_source(s: SourceIn, db: Session = Depends(get_db)):
    """Add a potential pollution source (e.g. a hospital found through OpenStreetMap)."""
    d = s.model_dump(); d["id"] = (d["id"] or "SRC-" + hashlib.md5(f"{s.name}|{s.lat:.5f}|{s.lon:.5f}".encode()).hexdigest()[:10])[:32]
    db.merge(Source(**d)); db.commit()
    return {"saved": d["id"]}


@app.get("/api/geo/reverse")
def geo_reverse(lat: float, lon: float):
    """Place name for a position (OpenStreetMap Nominatim, cached)."""
    r = osm.reverse(lat, lon)
    if r is None:
        raise HTTPException(503, "OpenStreetMap geocoding unavailable.")
    return r


@app.get("/api/geo/facilities")
def geo_facilities(lat: float, lon: float, radius: int = 800):
    """Hospitals, clinics, pharmacies, wastewater plants, outfalls and drains near a position (OpenStreetMap Overpass)."""
    r = osm.nearby_facilities(lat, lon, radius)
    if r is None:
        raise HTTPException(503, "OpenStreetMap Overpass API unavailable.")
    return r


@app.get("/api/weather")
def weather(lat: float, lon: float):
    w = integrations.weather_context(lat, lon)
    if w is None:
        raise HTTPException(503, "Weather service unavailable.")
    return w


# ------------------------------------------------------------------ export
@app.get("/api/export/{what}.csv", response_class=PlainTextResponse)
def export(what: str, hours: float = 168, db: Session = Depends(get_db)):
    buf = io.StringIO(); w = csv.writer(buf)
    if what == "readings":
        w.writerow(["ts", "device", "lat", "lon", *config.SENSOR_FIELDS, "status", f"est_{config.TARGET_COMPOUND}"])
        for r in db.scalars(select(Reading).where(Reading.ts >= datetime.now(timezone.utc) - timedelta(hours=hours)).order_by(Reading.ts)):
            w.writerow([aware(r.ts).isoformat(), r.device, r.lat, r.lon, *[getattr(r, k) for k in config.SENSOR_FIELDS], r.status,
                        (r.est or {}).get(config.TARGET_COMPOUND, {}).get("mu")])
    elif what == "hplc":
        w.writerow(["sample_id", "ts", "lat", "lon", "compound", "conc", "lod", "below", "method", "notes"])
        for h in db.scalars(select(HplcResult).order_by(HplcResult.ts)):
            w.writerow([h.sample_id, aware(h.ts).isoformat(), h.lat, h.lon, h.compound, h.conc, h.lod, h.below, h.method, h.notes])
    elif what == "events":
        w.writerow(["id", "device", "start", "end", "status", "lat", "lon", "peak_est", "confidence", "nearest_source", "source_dist_m", "place", "weather"])
        for e in db.scalars(select(Event).order_by(Event.start)):
            w.writerow([e.id, e.device, aware(e.start).isoformat(), aware(e.end).isoformat(), e.status, e.lat, e.lon, e.peak_est, e.peak_conf,
                        e.nearest_source, e.source_dist_m, (e.place or {}).get("short", ""), json.dumps(e.weather) if e.weather else ""])
    elif what.startswith("pairs"):
        comp = config.TARGET_COMPOUND
        w.writerow(["sample_id", "ts", "compound", "conc", "match_n", "dt_min", "dist_m", *config.SENSOR_FIELDS])
        for h, m in pipeline.paired_dataset(db, comp):
            if m["ok"]:
                w.writerow([h.sample_id, aware(h.ts).isoformat(), h.compound, h.conc, m["n"], round(m["dt_min"], 2), round(m["dist_m"], 1),
                            *[round(m["sensors"][k], 4) for k in config.SENSOR_FIELDS]])
    else:
        raise HTTPException(404, "Use readings, hplc, events or pairs.")
    return PlainTextResponse(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{what}.csv"'})


# ------------------------------------------------------------------ dashboard
@app.get("/boat.html", response_class=HTMLResponse, include_in_schema=False)
@app.get("/boat", response_class=HTMLResponse, include_in_schema=False)
def boat_page():
    """Phone transmitter page (open it on a phone over HTTPS)."""
    f = config.FRONTEND_FILE.parent / "boat.html"
    if f.exists():
        return FileResponse(f)
    raise HTTPException(404, "boat.html not built. Run frontend/build.sh.")


@app.get("/vendor/{name}", include_in_schema=False)
def vendor(name: str):
    f = (config.FRONTEND_FILE.parent / "vendor" / name).resolve()
    if f.parent != (config.FRONTEND_FILE.parent / "vendor").resolve() or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="application/javascript", headers={"Cache-Control": "max-age=86400"})


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def dashboard():
    if config.FRONTEND_FILE.exists():
        return FileResponse(config.FRONTEND_FILE)
    return HTMLResponse("<p>Dashboard not built. Run frontend/build.sh.</p>")
