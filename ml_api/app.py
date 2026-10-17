"""AquaTrace ML API: the screening model for 5 medicines (micropollutants), online.

Run on your laptop:   python -m uvicorn app:app --port 7860
Then open:            http://localhost:7860/docs   (try every endpoint in the browser)

Endpoints
  GET  /health          is the model loaded?
  GET  /models          the 5 medicine models: sensors, "high" level, testing scores
  GET  /models/{id}     one model card
  GET  /evaluation      confusion matrix, precision/recall/F1 vs random, mAP, algorithm comparison
  GET  /model-package   the full model file (the website loads its copy from here)
  POST /predict         one set of sensor readings -> P(high), lab flag, level estimate, per medicine
  POST /predict/batch   up to 5,000 readings at once
"""
import json
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from aquatrace_model import SENSORS, ModelPackage

HERE = Path(__file__).parent
MODEL_PATH = Path(os.getenv("MODEL_PATH", HERE / "aquatrace_colab_model.json"))
EVAL_PATH = Path(os.getenv("EVAL_PATH", HERE / "evaluation.json"))

PKG = ModelPackage(MODEL_PATH)
EVALUATION = json.loads(EVAL_PATH.read_text(encoding="utf-8")) if EVAL_PATH.exists() else {}
STARTED = time.time()
COUNT = {"predictions": 0}

app = FastAPI(
    title="AquaTrace ML API",
    version="1.0",
    description=(
        "Screens river water for 5 medicines from cheap sensor readings (pH, temperature, conductivity, "
        "turbidity, dissolved oxygen). Trained on 26,073 US lab results (Water Quality Portal) in three phases "
        "split by river site; scores are from rivers the model never saw. The model says **which samples to "
        "send to the lab**; HPLC / LC-MS stays the reference."
    ),
)
# Public, read-only model: any page (your laptop, Vercel, file://) may call it.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000)


class Readings(BaseModel):
    model_config = ConfigDict(extra="ignore", json_schema_extra={
        "example": {"ph": 7.6, "temp": 24.0, "conductivity": 950, "turbidity": 8.5, "do": 6.2, "month": 10}})
    ph: Optional[float] = Field(None, description="pH")
    temp: Optional[float] = Field(None, description="Water temperature, °C")
    conductivity: Optional[float] = Field(None, description="Conductivity, µS/cm")
    turbidity: Optional[float] = Field(None, description="Turbidity, NTU")
    do: Optional[float] = Field(None, description="Dissolved oxygen, mg/L")
    month: Optional[int] = Field(None, ge=1, le=12, description="Month of the reading, 1-12 (season input; default: this month)")
    timestamp: Optional[str] = Field(None, description="Time of the reading, e.g. 2026-10-17T09:30:00+08:00 (used for the month if month is empty)")


class PredictIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {
        "readings": {"ph": 7.6, "temp": 24.0, "conductivity": 950, "turbidity": 8.5, "do": 6.2, "month": 10},
        "compounds": None}})
    readings: Readings
    compounds: Optional[list[str]] = Field(None, description="Model ids, e.g. ['CBZ-US']; empty = all 5")


class BatchIn(BaseModel):
    items: list[Readings] = Field(..., max_length=5000)
    compounds: Optional[list[str]] = None


def _predict(readings: Readings, compounds):
    try:
        return PKG.predict(readings.model_dump(), compounds)
    except KeyError as e:
        raise HTTPException(404, f"Unknown model id: {e}. Known: {', '.join(PKG.models)}")


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def home():
    rows = "".join(f"<li><b>{m.name}</b> · sensors: {', '.join(m.feats)} · testing ROC-AUC "
                   f"{m.meta['screen_holdout']['auc']:.2f}</li>" for m in PKG.models.values())
    return f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AquaTrace ML API</title>
<body style="font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5;color:#0E2A3B;background:#F5F3EE">
<h1>AquaTrace ML API</h1>
<p>Online screening model for medicines in river water. Model built {PKG.created} · testing mAP
{PKG.summary.get('mAP_test', 0):.2f} (random {PKG.summary.get('random_mAP_test', 0):.2f}).</p>
<ul>{rows}</ul>
<p><a href="/docs">Try it: interactive API docs</a> · <a href="/health">/health</a> · <a href="/models">/models</a> ·
<a href="/evaluation">/evaluation</a></p></body>"""


@app.get("/health")
def health():
    return {"status": "ok", "service": "aquatrace-ml-api", "model_created": PKG.created,
            "models": list(PKG.models), "uptime_s": round(time.time() - STARTED),
            "predictions_served": COUNT["predictions"]}


@app.get("/models")
def models():
    return {"model_created": PKG.created, "summary": PKG.summary, "sensors": SENSORS,
            "models": [m.card() for m in PKG.models.values()]}


@app.get("/models/{model_id}")
def model_card(model_id: str):
    if model_id not in PKG.models:
        raise HTTPException(404, f"Unknown model id. Known: {', '.join(PKG.models)}")
    return PKG.models[model_id].card()


@app.get("/evaluation")
def evaluation():
    return EVALUATION


@app.get("/model-package")
def model_package():
    return FileResponse(MODEL_PATH, media_type="application/json", filename="aquatrace_colab_model.json")


@app.post("/predict")
def predict(body: PredictIn):
    t0 = time.perf_counter()
    res = _predict(body.readings, body.compounds)
    COUNT["predictions"] += 1
    return {"model_created": PKG.created, "readings": body.readings.model_dump(), "results": res,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2)}


@app.post("/predict/batch")
def predict_batch(body: BatchIn):
    t0 = time.perf_counter()
    out = [_predict(r, body.compounds) for r in body.items]
    COUNT["predictions"] += len(out)
    return {"model_created": PKG.created, "count": len(out), "results": out,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2)}
