"""Runtime configuration, read from environment variables (or a .env file loaded by the process manager)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BASE_DIR.parent


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


DATABASE_URL = _env("DATABASE_URL", f"sqlite:///{BASE_DIR / 'aquatrace.db'}")
MODEL_DIR = Path(_env("MODEL_DIR", str(BASE_DIR / "models")))
FRONTEND_FILE = Path(_env("FRONTEND_FILE", str(ROOT_DIR / "frontend" / "index.html")))

# Security. API_KEY protects write endpoints used by people (uploads, training).
# DEVICE_KEYS is a comma-separated list of "device_id:key" pairs for sensor ingest.
# Leave both empty only on a closed local network.
API_KEY = _env("API_KEY")
DEVICE_KEYS = dict(p.split(":", 1) for p in _env("DEVICE_KEYS").split(",") if ":" in p)
CORS_ORIGINS = [o.strip() for o in _env("CORS_ORIGINS", "*").split(",") if o.strip()]

# Anomaly detection
Z_THRESHOLD = float(_env("Z_THRESHOLD", "3.0"))
BASELINE_WINDOW = int(_env("BASELINE_WINDOW", "72"))
EVENT_GAP_MIN = float(_env("EVENT_GAP_MIN", "20"))
TARGET_COMPOUND = _env("TARGET_COMPOUND", "PCM")

# HPLC <-> sensor matching
MATCH_WINDOW_MIN = float(_env("MATCH_WINDOW_MIN", "15"))
MATCH_DIST_M = float(_env("MATCH_DIST_M", "300"))

# Optional integrations
MQTT_HOST = _env("MQTT_HOST")               # e.g. "mosquitto" in docker-compose
MQTT_PORT = int(_env("MQTT_PORT", "1883"))
MQTT_TOPIC = _env("MQTT_TOPIC", "aquatrace/+/readings")
MQTT_USER = _env("MQTT_USER")
MQTT_PASS = _env("MQTT_PASS")
ALERT_WEBHOOK_URL = _env("ALERT_WEBHOOK_URL")   # Slack/Teams/generic webhook for "possible contamination" alerts
OPEN_METEO_URL = _env("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
ENABLE_WEATHER = _env("ENABLE_WEATHER", "1") == "1"

# OpenStreetMap (basemap tiles, Nominatim reverse geocoding, Overpass facility search)
ENABLE_OSM = _env("ENABLE_OSM", "1") == "1"
OSM_CONTACT = _env("OSM_CONTACT")              # your email; OSM usage policy asks for an identifying contact
OSM_TILE_URL = _env("OSM_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
OSM_TILE_ATTRIBUTION = _env("OSM_TILE_ATTRIBUTION", "© OpenStreetMap contributors")
OSM_NOMINATIM_URL = _env("OSM_NOMINATIM_URL", "https://nominatim.openstreetmap.org")
OSM_OVERPASS_URL = _env("OSM_OVERPASS_URL", "https://overpass-api.de/api/interpreter")

SENSOR_FIELDS = ["ph", "orp", "turbidity", "uv", "temp", "conductivity", "do"]
VERSION = "0.1.0"
