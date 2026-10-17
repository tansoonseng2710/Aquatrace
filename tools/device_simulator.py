"""Stand-in for the boat's sensor node: posts synthetic readings to a running AquaTrace API
through the real ingest path (HTTP or MQTT). Use it to test a deployment end to end before
the hardware is ready.

    python tools/device_simulator.py --url http://localhost:8000 --key DEVICE_KEY --every 5
    python tools/device_simulator.py --mqtt localhost --every 5
    python tools/device_simulator.py --speedup 60     # one simulated minute per real second
"""
import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
import httpx  # noqa: E402

from app.demo_world import World  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000"); ap.add_argument("--key", default="")
    ap.add_argument("--device", default="BOAT-01"); ap.add_argument("--every", type=float, default=5.0, help="seconds between posts")
    ap.add_argument("--speedup", type=float, default=1.0, help="simulated seconds per real second")
    ap.add_argument("--mqtt", default="", help="MQTT broker host instead of HTTP"); ap.add_argument("--count", type=int, default=0)
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    world = World(now - timedelta(days=1), seed=int(now.timestamp()) % 10000, days=4)
    sim_t, n = now, 0
    client = None
    if a.mqtt:
        import paho.mqtt.client as mqtt
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2); client.connect(a.mqtt, 1883); client.loop_start()
    while not a.count or n < a.count:
        r, _ = world.sample(sim_t)
        body = {**r, "ts": sim_t.isoformat(), "device": a.device}
        try:
            if client:
                client.publish(f"aquatrace/{a.device}/readings", json.dumps(body))
                print(sim_t.isoformat(), "published")
            else:
                res = httpx.post(f"{a.url}/api/ingest", json=body, headers={"X-API-Key": a.key}, timeout=10).json()
                est = (res.get("est") or {}).get("PCM", {})
                print(f"{sim_t:%H:%M:%S} {res.get('status', '?'):>4}  pH {r['ph']:.2f}  UV {r['uv']:.3f}  est PCM {est.get('mu', 0):.3f} mg/L")
        except Exception as e:
            print("post failed:", e)
        n += 1
        time.sleep(a.every)
        sim_t += timedelta(seconds=a.every * a.speedup)


if __name__ == "__main__":
    main()
