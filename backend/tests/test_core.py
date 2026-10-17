"""Core science checks. Run from backend/:  pytest -q"""
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ["MODEL_DIR"] = tempfile.mkdtemp()
os.environ["ENABLE_WEATHER"] = "0"

from app.services import core, ml  # noqa: E402


def test_units_and_distance():
    assert core.convert(120, "µg/L", "mg/L") == pytest.approx(0.12)
    assert core.convert(5, "ng/L", "µg/L") == pytest.approx(0.005)
    assert core.convert(1, "furlongs", "mg/L") is None
    # SP1 -> SP5 on Sungai Pinang is roughly 2 km
    assert 1800 < core.dist_m(5.410733, 100.313743, 5.403843, 100.330476) < 2100


def test_matching_prefers_close_readings():
    t0 = datetime(2026, 9, 1, 2, 0, tzinfo=timezone.utc)
    near = {"ts": t0 + timedelta(minutes=1), "lat": 5.4081, "lon": 100.3228, **{k: 1.0 for k in core.config.SENSOR_FIELDS}}
    far_t = {"ts": t0 + timedelta(minutes=40), "lat": 5.4081, "lon": 100.3228, **{k: 9.0 for k in core.config.SENSOR_FIELDS}}
    far_d = {"ts": t0, "lat": 5.42, "lon": 100.34, **{k: 9.0 for k in core.config.SENSOR_FIELDS}}
    m = core.match_sample({"ts": t0, "lat": 5.4081, "lon": 100.3228}, [near, far_t, far_d])
    assert m["ok"] and m["n"] == 1 and m["sensors"]["uv"] == 1.0
    assert not core.match_sample({"ts": t0, "lat": 0, "lon": 0}, [near])["ok"]


def test_baseline_flags_step_change():
    b = core.Baseline(window=20, z_th=3)
    rng = np.random.default_rng(0)
    for _ in range(60):
        b.score("D", {"uv": 0.10 + rng.normal(0, 0.005), "conductivity": 600})
    _, z = b.score("D", {"uv": 0.30, "conductivity": 600})
    assert z["uv"] > 3
    # moving to seawater starts a new baseline instead of an alarm
    zone, z = b.score("D", {"uv": 0.10, "conductivity": 42000})
    assert zone == "coast" and z["uv"] == 0


def test_kinetics_recovers_first_order_rate():
    rows = [{"time_h": t, "conc": 5 * math.exp(-0.8 * t), "toc": 4 - 0.1 * t} for t in np.arange(0, 3.01, 0.5)]
    k = core.kinetics(rows)
    assert k["k_per_h"] == pytest.approx(0.8, rel=1e-6) and k["r2"] == pytest.approx(1.0)
    assert k["removal_pct"] == pytest.approx((1 - math.exp(-2.4)) * 100)


def test_reactor_verdict_needs_controls():
    run = {"catalyst": "Fe2O3-TiO2", "light": "sun", "rows": [{"time_h": t, "conc": 5 * math.exp(-1 * t)} for t in range(4)]}
    ctrl = {"catalyst": "none", "light": "sun", "rows": [{"time_h": t, "conc": 5 * math.exp(-0.05 * t)} for t in range(4)]}
    assert core.reactor_verdict(run, [], [])["verdict"] == "inconclusive"
    assert core.reactor_verdict(run, [ctrl], [])["verdict"] == "supported"
    weak = {**run, "rows": [{"time_h": t, "conc": 5 * math.exp(-0.08 * t)} for t in range(4)]}
    assert core.reactor_verdict(weak, [ctrl], [])["verdict"] == "not_supported"


def test_ml_learns_signal_and_reports_uncertainty():
    rng = np.random.default_rng(1)
    X = rng.uniform(0, 1, (60, 3)); y = 0.3 * X[:, 0] + 0.02 * rng.normal(size=60)
    b = ml.train(X, y, ["uv", "ph", "orp"], "rf")
    assert b["metrics"]["r2_cv"] > 0.7
    assert max(b["metrics"]["importance"], key=b["metrics"]["importance"].get) == "uv"
    e = ml.predict(b, {"uv": 0.5, "ph": 0.5, "orp": 0.5})
    assert e["lo"] <= e["mu"] <= e["hi"]
    out = ml.predict(b, {"uv": 5.0, "ph": 0.5, "orp": 0.5})   # far outside training range
    assert out["conf"] == "Low" and "uv" in out["outside"]
    with pytest.raises(ValueError):
        ml.train(X[:5], y[:5], ["uv", "ph", "orp"])


def test_api_end_to_end():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        assert c.get("/api/health").json()["status"] == "ok"
        r = c.post("/api/ingest", json={"device": "T1", "lat": 5.408, "lon": 100.322, "ph": 7.1, "orp": 300, "turbidity": 4,
                                        "uv": 0.12, "temp": 29, "conductivity": 600, "do": 6.5})
        assert r.status_code == 201 and r.json()["status"] in {"ok", "warn", "bad"}
        csv_text = "sample_id,timestamp,lat,lon,compound,concentration,unit,lod\nX1,2026-09-29T10:00:00+08:00,5.408,100.322,Paracetamol,150,µg/L,5\n"
        res = c.post("/api/hplc/csv", content=csv_text.encode()).json()
        assert res["saved"] == 1
        h = [x for x in c.get("/api/bootstrap").json()["hplc"] if x["sample_id"] == "X1"][0]
        assert h["conc"] == pytest.approx(0.15)       # converted to the compound's unit (mg/L)
        assert c.post("/api/ml/train", json={"compound": "PCM"}).status_code == 422   # too few pairs, clear message


def test_sample_files_import_and_vendor_route():
    from pathlib import Path
    from fastapi.testclient import TestClient
    from app.main import app
    samples = Path(__file__).resolve().parents[2] / "samples"
    with TestClient(app) as c:
        for name, n in [("hplc_results_example.csv", 4), ("hplc_with_sensors_example.csv", 3)]:
            res = c.post("/api/hplc/csv", content=(samples / name).read_bytes()).json()
            assert res["saved"] == n and not res["errors"], res
        pairs = c.get("/api/pairs", params={"compound": "PCM"}).json()
        direct = [p for p in pairs if p["sample_id"] == "002"][0]
        assert direct["match"]["direct"] and direct["match"]["sensors"]["uv"] == 0.42
        below = [h for h in c.get("/api/bootstrap").json()["hplc"] if h["compound"] == "DIC" and h["sample_id"] == "S-101"][0]
        assert below["below"] and below["conc"] == pytest.approx(0.027)
        assert c.get("/vendor/chart.umd.min.js").status_code == 200
        assert c.get("/vendor/..%2Fapp%2Fmain.py").status_code == 404


# ---------------------------------------------------------------- OpenStreetMap
NOMINATIM_SAMPLE = {"place_id": 1, "osm_type": "way", "osm_id": 23456, "lat": "5.4081", "lon": "100.3228", "name": "",
                    "display_name": "Jalan Sungai Pinang, Kampung Rawa, George Town, Penang, 10150, Malaysia",
                    "address": {"road": "Jalan Sungai Pinang", "suburb": "Kampung Rawa", "city": "George Town",
                                "state": "Penang", "postcode": "10150", "country": "Malaysia"}}
OVERPASS_SAMPLE = {"elements": [
    {"type": "way", "id": 111, "center": {"lat": 5.4167, "lon": 100.3108}, "tags": {"amenity": "hospital", "name": "Penang General Hospital"}},
    {"type": "node", "id": 222, "lat": 5.4085, "lon": 100.3232, "tags": {"amenity": "pharmacy"}},
    {"type": "node", "id": 222, "lat": 5.4085, "lon": 100.3232, "tags": {"amenity": "pharmacy"}},          # duplicate from a 2nd query
    {"type": "way", "id": 333, "center": {"lat": 5.3973, "lon": 100.3230}, "tags": {"man_made": "wastewater_plant", "name": "Jelutong STP"}},
    {"type": "relation", "id": 444, "tags": {"landuse": "industrial"}},                                   # no centre: skipped
]}


class _Resp:
    def __init__(self, j): self._j = j
    def raise_for_status(self): pass
    def json(self): return self._j


def test_osm_parsing_and_endpoints(monkeypatch):
    from app.services import osm
    calls = []
    monkeypatch.setattr(osm.config, "ENABLE_OSM", True)
    monkeypatch.setattr(osm.httpx, "get", lambda url, **k: calls.append(("get", url, k)) or _Resp(NOMINATIM_SAMPLE))
    monkeypatch.setattr(osm.httpx, "post", lambda url, **k: calls.append(("post", url, k)) or _Resp(OVERPASS_SAMPLE))
    osm._cache.clear()
    r = osm.reverse(5.4081, 100.3228)
    assert r["short"] == "Jalan Sungai Pinang, Kampung Rawa, George Town" and r["osm"] == "way/23456"
    assert "AquaTrace" in calls[0][2]["headers"]["User-Agent"] and calls[0][2]["params"]["format"] == "jsonv2"
    osm.reverse(5.40811, 100.32281)                     # same ~11 m cell: served from cache
    assert len(calls) == 1
    f = osm.nearby_facilities(5.4081, 100.3228, 1500)
    names = [i["name"] for i in f["items"]]
    assert names[0] == "Unnamed pharmacy" and len(names) == 3            # sorted by distance, deduplicated, centre-less skipped
    assert {i["category"] for i in f["items"]} == {"Pharmacy", "Hospital", "Wastewater treatment plant"}
    q = calls[-1][2]["data"]["data"]
    assert q.startswith("[out:json]") and 'nwr["amenity"="hospital"](around:1500,5.4081,100.3228);' in q
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        assert c.get("/api/geo/facilities", params={"lat": 5.4081, "lon": 100.3228, "radius": 1500}).json()["items"][2]["name"] == "Penang General Hospital"
        assert c.get("/api/health").json()["map"]["tile_url"].startswith("https://tile.openstreetmap.org")
        sid = c.post("/api/sources", json={"name": "Penang General Hospital", "type": "Hospital (OSM)", "lat": 5.4167, "lon": 100.3108,
                                           "basis": "OpenStreetMap way/111"}).json()["saved"]
        assert any(s["id"] == sid for s in c.get("/api/bootstrap").json()["sources"])
    monkeypatch.setattr(osm.httpx, "get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("offline")))
    osm._cache.clear()
    assert osm.reverse(1.0, 1.0) is None                 # fails soft


def test_additive_migration_adds_new_columns(tmp_path, monkeypatch):
    import sqlite3
    from sqlalchemy import create_engine, inspect
    from app import db as dbm
    path = tmp_path / "old.db"
    con = sqlite3.connect(path); con.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, device VARCHAR(64))"); con.commit(); con.close()
    eng = create_engine(f"sqlite:///{path}")
    monkeypatch.setattr(dbm, "engine", eng)
    dbm.init_db()
    cols = {c["name"] for c in inspect(eng).get_columns("events")}
    assert {"place", "weather", "peak_est"} <= cols


def test_phone_readings_and_device_list():
    """A phone posting through the ingest API shows up in the fleet list with its details."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app import config
    with TestClient(app) as c:
        body = [{"device": "PHONE-TEST", "name": "Phone boat TEST", "lat": 5.4033, "lon": 100.3356, "ph": 7.0 + i * 0.01, "orp": 300, "turbidity": 5,
                 "uv": 0.1, "temp": 29, "conductivity": 600, "do": 6.5, "battery": 0.8, "mode": "gps", "acc": 9} for i in range(3)]
        assert c.post("/api/ingest", json=body, headers={"X-Device-Id": "PHONE-TEST"}).status_code == 201
        devs = {d["device"]: d for d in c.get("/api/devices").json()}
        d = devs["PHONE-TEST"]
        assert d["name"] == "Phone boat TEST" and d["readings"] == 3 and d["meta"]["battery"] == 0.8
        last = c.get("/api/readings/latest", params={"device": "PHONE-TEST"}).json()
        assert last["extra"]["mode"] == "gps"
        if (config.FRONTEND_FILE.parent / "boat.html").exists():
            assert "AquaTrace boat" in c.get("/boat").text


def test_esp32_bench_node_partial_reading():
    """The ESP32 bench node sends pH and turbidity only; the server stores them without inventing the rest."""
    from fastapi.testclient import TestClient
    from app.main import app
    payload = {"device": "ESP32-BENCH-01", "name": "Bench sensor node", "kind": "esp32", "fw": "1.0", "seq": 7,
               "lat": 5.408132, "lon": 100.322845, "ph": 7.02, "turbidity": 3.4, "ph_mv": 2496, "turb_mv": 4108,
               "turb_cal": "clear-water", "rssi": -61, "uptime_s": 120, "every_s": 2,
               "cal": {"ph7_mv": 2500, "ph4_mv": 3030, "clear_mv": 4110}, "ack": "Clear-water point saved at 4110 mV"}
    with TestClient(app) as c:
        r = c.post("/api/ingest", json=payload, headers={"X-Device-Id": "ESP32-BENCH-01"})
        assert r.status_code == 201 and r.json()["est"] == {}          # no estimate from two parameters
        last = c.get("/api/readings/latest", params={"device": "ESP32-BENCH-01"}).json()
        assert last["ph"] == 7.02 and last["turbidity"] == 3.4 and last["uv"] is None and last["do"] is None
        assert last["extra"]["kind"] == "esp32" and last["extra"]["cal"]["clear_mv"] == 4110 and last["extra"]["turb_cal"] == "clear-water"
        d = {x["device"]: x for x in c.get("/api/devices").json()}["ESP32-BENCH-01"]
        assert d["meta"]["rssi"] == -61


def test_nano_node_via_serial_bridge():
    """The Arduino Nano sends the same JSON over USB; tools/serial_bridge.py adds ts and via, then posts it."""
    from fastapi.testclient import TestClient
    from app.main import app
    payload = {"device": "NANO-BENCH-01", "name": "Bench sensor node (Nano)", "kind": "nano", "fw": "1.0-nano", "seq": 3,
               "lat": 5.408132, "lon": 100.322845, "ph": 6.96, "turbidity": 0.0, "ph_mv": 2507, "turb_mv": 4113,
               "vcc_mv": 4979, "turb_cal": "clear-water", "uptime_s": 26, "every_s": 2,
               "cal": {"ph7_mv": 2500, "ph4_mv": 3030, "clear_mv": 4112}, "ts": "2026-10-02T15:01:25Z", "via": "bridge"}
    with TestClient(app) as c:
        r = c.post("/api/ingest", json=payload)
        assert r.status_code == 201 and r.json()["est"] == {}
        last = c.get("/api/readings/latest", params={"device": "NANO-BENCH-01"}).json()
        assert last["ph"] == 6.96 and last["extra"]["kind"] == "nano" and last["extra"]["vcc_mv"] == 4979 and last["extra"]["via"] == "bridge"
