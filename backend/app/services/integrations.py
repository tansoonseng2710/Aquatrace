"""External APIs: Open-Meteo weather context and alert webhooks. Both fail soft."""
from __future__ import annotations

import logging
from datetime import datetime

import httpx

from .. import config

log = logging.getLogger("aquatrace.integrations")


def weather_context(lat: float, lon: float, when: datetime | None = None) -> dict | None:
    """Rainfall over the previous 24 h and current temperature from Open-Meteo (free, no key).
    Rain drives turbidity and dilution, so every event is stored with this context."""
    if not config.ENABLE_WEATHER:
        return None
    try:
        r = httpx.get(config.OPEN_METEO_URL, params={
            "latitude": round(lat, 4), "longitude": round(lon, 4),
            "hourly": "precipitation,temperature_2m", "past_days": 1, "forecast_days": 1, "timezone": "UTC"}, timeout=6)
        r.raise_for_status()
        h = r.json()["hourly"]
        times = h["time"]; now = (when or datetime.utcnow()).strftime("%Y-%m-%dT%H:00")
        idx = times.index(now) if now in times else len(times) // 2
        rain24 = sum(p or 0 for p in h["precipitation"][max(0, idx - 24): idx + 1])
        return {"rain_24h_mm": round(rain24, 1), "rain_1h_mm": h["precipitation"][idx], "air_temp_c": h["temperature_2m"][idx], "source": "open-meteo.com"}
    except Exception as e:  # network off, API change, etc.
        log.warning("weather lookup failed: %s", e)
        return None


def notify(event: dict) -> bool:
    """POST a 'possible contamination' alert to ALERT_WEBHOOK_URL (Slack-compatible 'text' payload)."""
    if not config.ALERT_WEBHOOK_URL:
        return False
    text = (f"⚠ Possible contamination detected ({event['device']})\n"
            f"Location: {event['lat']:.4f}° N, {event['lon']:.4f}° E" + (f" ({event['place']})" if event.get("place") else "") + "\n"
            f"Map: https://www.openstreetmap.org/?mlat={event['lat']:.5f}&mlon={event['lon']:.5f}#map=17/{event['lat']:.5f}/{event['lon']:.5f}\n"
            f"Estimated {event.get('compound')}: {event.get('peak_est'):.4g} (confidence {event.get('peak_conf')})\n"
            f"Main change: {event['drivers'][0]['k']} (z {event['drivers'][0]['z']:+.1f})\n"
            f"Nearest potential source: {event.get('nearest_source')} ({event.get('source_dist_m', 0):.0f} m)\n"
            f"Screening estimate only. Laboratory (HPLC) confirmation recommended.")
    try:
        httpx.post(config.ALERT_WEBHOOK_URL, json={"text": text}, timeout=6).raise_for_status()
        return True
    except Exception as e:
        log.warning("alert webhook failed: %s", e)
        return False
