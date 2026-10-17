"""OpenStreetMap APIs used for spatial pollution investigation.

- Nominatim reverse geocoding: turns an event position into a place name ("Jalan Sungai, Jelutong").
- Overpass API: finds facilities near an event that can release pharmaceuticals
  (hospitals, clinics, pharmacies, wastewater plants, outfalls, drains).

Both follow the OSM usage policies: an identifying User-Agent (set OSM_CONTACT to your email),
at most one Nominatim request per second, and results cached. Both fail soft (return None) so
monitoring never depends on them. Point OSM_NOMINATIM_URL / OSM_OVERPASS_URL at your own
instances for heavy use.
"""
from __future__ import annotations

import logging
import threading
import time

import httpx

from .. import config
from .core import dist_m

log = logging.getLogger("aquatrace.osm")
_lock = threading.Lock()
_last_call = 0.0
_cache: dict[tuple, tuple[float, object]] = {}
CACHE_S = 7 * 86400

# OSM tag -> (category shown in the app, relevance to pharmaceutical contamination)
FACILITY_QUERIES = [
    ('nwr["amenity"="hospital"]', "Hospital"),
    ('nwr["healthcare"="hospital"]', "Hospital"),
    ('nwr["amenity"="clinic"]', "Clinic"),
    ('nwr["amenity"="doctors"]', "Clinic"),
    ('nwr["amenity"="pharmacy"]', "Pharmacy"),
    ('nwr["man_made"="wastewater_plant"]', "Wastewater treatment plant"),
    ('nwr["man_made"="outfall"]', "Outfall"),
    ('nwr["waterway"="drain"]', "Drain"),
    ('nwr["amenity"="veterinary"]', "Veterinary clinic"),
    ('nwr["landuse"="industrial"]', "Industrial area"),
]


def _headers() -> dict:
    ua = f"AquaTrace/{config.VERSION} (water-quality research prototype"
    ua += f"; {config.OSM_CONTACT})" if config.OSM_CONTACT else ")"
    return {"User-Agent": ua, "Accept-Language": "en"}


def _cached(key):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    return None


def reverse(lat: float, lon: float) -> dict | None:
    """Nominatim reverse geocode. Cached on a ~11 m grid."""
    if not config.ENABLE_OSM:
        return None
    key = ("rev", round(lat, 4), round(lon, 4))
    if (c := _cached(key)) is not None:
        return c
    global _last_call
    try:
        with _lock:                                   # Nominatim policy: max 1 request per second
            wait = 1.05 - (time.time() - _last_call)
            if wait > 0:
                time.sleep(wait)
            _last_call = time.time()
            r = httpx.get(f"{config.OSM_NOMINATIM_URL}/reverse", headers=_headers(), timeout=8,
                          params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 17, "addressdetails": 1})
        r.raise_for_status()
        out = parse_reverse(r.json())
        _cache[key] = (time.time(), out)
        return out
    except Exception as e:
        log.warning("Nominatim reverse failed: %s", e)
        return None


def parse_reverse(j: dict) -> dict | None:
    if not j or "error" in j:
        return None
    a = j.get("address", {})
    road = a.get("road") or a.get("pedestrian") or a.get("footway") or a.get("waterway")
    area = a.get("suburb") or a.get("neighbourhood") or a.get("quarter") or a.get("village") or a.get("town")
    city = a.get("city") or a.get("town") or a.get("county")
    short = ", ".join(x for x in [j.get("name") if j.get("name") and j.get("name") != road else None, road, area, city] if x)
    return {"short": short or j.get("display_name", ""), "display_name": j.get("display_name", ""),
            "osm": f"{j.get('osm_type', '')}/{j.get('osm_id', '')}", "source": "© OpenStreetMap contributors (Nominatim)"}


def overpass_query(lat: float, lon: float, radius: int) -> str:
    body = "".join(f"{q}(around:{radius},{lat},{lon});" for q, _ in FACILITY_QUERIES)
    return f"[out:json][timeout:25];({body});out center tags 200;"


def nearby_facilities(lat: float, lon: float, radius: int = 800) -> dict | None:
    """Overpass search for facilities that may release pharmaceuticals, sorted by distance."""
    if not config.ENABLE_OSM:
        return None
    radius = max(50, min(int(radius), 5000))
    key = ("ovp", round(lat, 3), round(lon, 3), radius)
    if (c := _cached(key)) is not None:
        return c
    try:
        r = httpx.post(config.OSM_OVERPASS_URL, data={"data": overpass_query(lat, lon, radius)}, headers=_headers(), timeout=30)
        r.raise_for_status()
        out = {"radius_m": radius, "items": parse_overpass(r.json(), lat, lon), "source": "© OpenStreetMap contributors (Overpass API)"}
        _cache[key] = (time.time(), out)
        return out
    except Exception as e:
        log.warning("Overpass query failed: %s", e)
        return None


def _category(tags: dict) -> str:
    for q, cat in FACILITY_QUERIES:
        k, v = q.split("[", 1)[1].rstrip("]").replace('"', "").split("=")
        if tags.get(k) == v:
            return cat
    return "Other"


def parse_overpass(j: dict, lat: float, lon: float) -> list[dict]:
    seen, items = set(), []
    for el in j.get("elements", []):
        p = el if "lat" in el else el.get("center")
        if not p:
            continue
        tags = el.get("tags", {})
        oid = f"{el['type']}/{el['id']}"
        if oid in seen:
            continue
        seen.add(oid)
        cat = _category(tags)
        items.append({"osm": oid, "name": tags.get("name") or tags.get("name:en") or f"Unnamed {cat.lower()}", "category": cat,
                      "lat": p["lat"], "lon": p["lon"], "dist_m": round(dist_m(lat, lon, p["lat"], p["lon"]), 1),
                      "url": f"https://www.openstreetmap.org/{oid}"})
    return sorted(items, key=lambda x: x["dist_m"])
