"""AquaTrace ML API, basic mode: the same model and the same endpoints, using only Python's standard library.

No FastAPI, no internet, nothing to install. run_ml_api_local.bat uses this automatically when FastAPI
cannot be installed. (The interactive /docs page needs FastAPI; everything else works the same.)

Run:   python serve_basic.py            then open http://localhost:7860
"""
import json
import math
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from aquatrace_model import SENSORS, ModelPackage

HERE = Path(__file__).parent
MODEL_PATH = Path(os.getenv("MODEL_PATH", HERE / "aquatrace_colab_model.json"))
EVAL_PATH = Path(os.getenv("EVAL_PATH", HERE / "evaluation.json"))
PKG = ModelPackage(MODEL_PATH)
EVALUATION = json.loads(EVAL_PATH.read_text(encoding="utf-8")) if EVAL_PATH.exists() else {}
MODEL_BYTES = MODEL_PATH.read_bytes()
STARTED = time.time()
COUNT = {"predictions": 0}


class BadRequest(Exception):
    def __init__(self, status, detail):
        super().__init__(detail)
        self.status, self.detail = status, detail


def readings_from(obj):
    if not isinstance(obj, dict):
        raise BadRequest(422, "readings must be an object like {\"ph\": 7.6, \"temp\": 24}")
    out = {}
    for k in SENSORS:
        v = obj.get(k)
        if v is None:
            out[k] = None
            continue
        try:
            out[k] = float(v)
        except (TypeError, ValueError):
            raise BadRequest(422, f"{k} must be a number")
        if not math.isfinite(out[k]):
            raise BadRequest(422, f"{k} must be a finite number")
    m = obj.get("month")
    if m is not None:
        try:
            m = int(float(m))
        except (TypeError, ValueError):
            raise BadRequest(422, "month must be a whole number 1-12")
        if not 1 <= m <= 12:
            raise BadRequest(422, "month must be 1-12")
    out["month"] = m
    out["timestamp"] = obj.get("timestamp") if isinstance(obj.get("timestamp"), str) else None
    return out


def compounds_from(c):
    if c in (None, []):
        return None
    if not isinstance(c, list) or not all(isinstance(x, str) for x in c):
        raise BadRequest(422, "compounds must be a list of model ids, e.g. [\"CBZ-US\"]")
    unknown = [x for x in c if x not in PKG.models]
    if unknown:
        raise BadRequest(404, f"Unknown model id: {', '.join(unknown)}. Known: {', '.join(PKG.models)}")
    return c


def home_html():
    rows = "".join(f"<li><b>{m.name}</b> · sensors: {', '.join(m.feats)} · testing ROC-AUC "
                   f"{m.meta['screen_holdout']['auc']:.2f}</li>" for m in PKG.models.values())
    return f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AquaTrace ML API</title>
<body style="font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5;color:#0E2A3B;background:#F5F3EE">
<h1>AquaTrace ML API</h1>
<p>Online screening model for medicines in river water. Model built {PKG.created} · testing mAP
{PKG.summary.get('mAP_test', 0):.2f} (random {PKG.summary.get('random_mAP_test', 0):.2f}).</p>
<p><b>Basic mode</b> (Python standard library, nothing installed): every endpoint works; the interactive /docs page
needs FastAPI.</p>
<ul>{rows}</ul>
<p><a href="/health">/health</a> · <a href="/models">/models</a> · <a href="/evaluation">/evaluation</a></p></body>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "AquaTraceBasic/1.0"

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode("utf-8") if ctype == "application/json" else body.encode("utf-8"))
        self.send_response(status)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):  # CORS preflight: any page may call this public, read-only model
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers", "*"))
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/":
            return self._send(200, home_html(), "text/html")
        if path == "/health":
            return self._send(200, {"status": "ok", "service": "aquatrace-ml-api", "mode": "basic", "model_created": PKG.created,
                                    "models": list(PKG.models), "uptime_s": round(time.time() - STARTED),
                                    "predictions_served": COUNT["predictions"]})
        if path == "/models":
            return self._send(200, {"model_created": PKG.created, "summary": PKG.summary, "sensors": SENSORS,
                                    "models": [m.card() for m in PKG.models.values()]})
        if path.startswith("/models/"):
            mid = path.split("/", 2)[2]
            if mid not in PKG.models:
                return self._send(404, {"detail": f"Unknown model id. Known: {', '.join(PKG.models)}"})
            return self._send(200, PKG.models[mid].card())
        if path == "/evaluation":
            return self._send(200, EVALUATION)
        if path == "/model-package":
            return self._send(200, MODEL_BYTES)
        if path in ("/docs", "/redoc"):
            return self._send(200, home_html(), "text/html")
        return self._send(404, {"detail": "Not Found"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20_000_000:
                raise BadRequest(413, "Request too large")
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise BadRequest(422, "Body must be JSON")
            t0 = time.perf_counter()
            if path == "/predict":
                rd = readings_from(body.get("readings"))
                res = PKG.predict(rd, compounds_from(body.get("compounds")))
                COUNT["predictions"] += 1
                return self._send(200, {"model_created": PKG.created, "readings": rd, "results": res,
                                        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2)})
            if path == "/predict/batch":
                items = body.get("items")
                if not isinstance(items, list) or len(items) > 5000:
                    raise BadRequest(422, "items must be a list of at most 5,000 readings")
                comps = compounds_from(body.get("compounds"))
                out = [PKG.predict(readings_from(r), comps) for r in items]
                COUNT["predictions"] += len(out)
                return self._send(200, {"model_created": PKG.created, "count": len(out), "results": out,
                                        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2)})
            raise BadRequest(404, "Not Found")
        except BadRequest as e:
            return self._send(e.status, {"detail": e.detail})

    def log_message(self, fmt, *args):  # one short line per request
        sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


if __name__ == "__main__":
    port = int(os.getenv("PORT", sys.argv[1] if len(sys.argv) > 1 else 7860))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"AquaTrace ML API (basic mode) at http://localhost:{port}  ·  {len(PKG.models)} models  ·  Ctrl+C to stop", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
