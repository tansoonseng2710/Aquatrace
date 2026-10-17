"""Stand-in for the ESP32 bench node (firmware/aquatrace_bench_node): sends the same JSON on the same
MQTT topics, answers the same calibration commands, and converts sensor millivolts with the same
formulas. Use it to test the dashboard's Sensor node page before the hardware is wired.

    python tools/esp32_emulator.py --code ABCDE                      # public EMQX broker, like the firmware default
    python tools/esp32_emulator.py --code ABCDE --host localhost      # local broker
    python tools/esp32_emulator.py --http http://localhost:8000/api/ingest
    python tools/esp32_emulator.py --code ABCDE --mud-at 60 --acid-at 120    # scripted water changes
"""
import argparse
import json
import math
import random
import sys
import time
from datetime import datetime, timezone

DEFAULT_CAL = {"ph7": 2500.0, "ph4": 3030.0, "clear": 4200.0, "ref": 0.0, "ref_ntu": 0.0, "clear_done": False}
A, B, C0 = 1120.4, 5742.3, 4352.9          # SEN0189 curve used by the firmware


def curve(v):
    return -A * v * v + B * v - C0


def ph_from_mv(mv, cal):
    slope = (cal["ph4"] - cal["ph7"]) / 3.0
    return max(0.0, min(14.0, 7.0 - (mv - cal["ph7"]) / slope))


def ntu_from_mv(mv, cal):
    if cal["ref_ntu"] > 0 and cal["ref"] > 0 and cal["clear"] - cal["ref"] > 50:
        return max(0.0, cal["ref_ntu"] * (cal["clear"] - mv) / (cal["clear"] - cal["ref"]))
    v = mv / 1000 + (4.2 - cal["clear"] / 1000)
    if v >= 4.2:
        return 0.0
    return max(0.0, curve(max(v, 2.5)) - curve(4.2))


def sensor_mv_for_ntu(ntu, clear_true_mv=4120.0):
    c = C0 + 0.9 + ntu
    v = (B + math.sqrt(max(0.0, B * B - 4 * A * c))) / (2 * A)
    return (v - (4.2 - clear_true_mv / 1000)) * 1000


class Node:
    def __init__(self, a):
        self.a, self.cal, self.every, self.seq, self.t0 = a, dict(DEFAULT_CAL), a.every, 0, time.time()
        self.mud = self.acid = 0.0
        self.ph_mv = self.turb_mv = None
        self.ack = ""

    def sample(self):
        self.mud *= 0.93
        self.acid *= 0.96
        ph_true, ntu_true = 7.15 - self.acid, 2 + self.mud
        ph = 2500 + (7 - ph_true) * 177 + random.gauss(0, 3)
        tu = sensor_mv_for_ntu(ntu_true) + random.gauss(0, 1.5)
        self.ph_mv = ph if self.ph_mv is None else self.ph_mv + 0.5 * (ph - self.ph_mv)
        self.turb_mv = tu if self.turb_mv is None else self.turb_mv + 0.5 * (tu - self.turb_mv)

    def payload(self):
        self.seq += 1
        cal = self.cal
        d = {"device": self.a.device, "name": self.a.name, "kind": "esp32", "fw": "1.0-emu", "seq": self.seq,
             "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": self.a.lat, "lon": self.a.lon,
             "ph": round(ph_from_mv(self.ph_mv, cal), 2), "turbidity": round(ntu_from_mv(self.turb_mv, cal), 1),
             "ph_mv": round(self.ph_mv), "turb_mv": round(self.turb_mv),
             "turb_cal": "two-point" if cal["ref_ntu"] > 0 else "clear-water" if cal["clear_done"] else "default",
             "rssi": -60, "uptime_s": int(time.time() - self.t0), "every_s": self.every,
             "cal": {"ph7_mv": int(cal["ph7"]), "ph4_mv": int(cal["ph4"]), "clear_mv": int(cal["clear"])}}
        if cal["ref_ntu"] > 0:
            d["cal"].update(ref_mv=int(cal["ref"]), ref_ntu=cal["ref_ntu"])
        if self.ack:
            d["ack"], self.ack = self.ack, ""
        return d

    def command(self, cmd, value=None):
        c = self.cal
        if cmd == "cal_ph7":
            c["ph7"] = self.ph_mv; self.ack = f"pH 7 point saved at {self.ph_mv:.0f} mV"
        elif cmd == "cal_ph4":
            if abs(self.ph_mv - c["ph7"]) < 60:
                self.ack = "pH 4 not saved: reading is too close to the pH 7 point. Check the buffer and wait for the reading to settle."
            else:
                c["ph4"] = self.ph_mv; self.ack = f"pH 4 point saved at {self.ph_mv:.0f} mV; slope {(c['ph4'] - c['ph7']) / 3:.1f} mV per pH"
        elif cmd == "cal_clear":
            c.update(clear=self.turb_mv, ref=0.0, ref_ntu=0.0, clear_done=True); self.ack = f"Clear-water point saved at {self.turb_mv:.0f} mV"
        elif cmd == "cal_ref":
            if not value or value <= 0:
                self.ack = "Give the reference turbidity, e.g. cal ref 100"
            elif c["clear"] - self.turb_mv < 50:
                self.ack = "Reference not saved: the sample reads almost the same as clear water."
            else:
                c.update(ref=self.turb_mv, ref_ntu=float(value)); self.ack = f"Reference point saved: {value:.0f} NTU at {self.turb_mv:.0f} mV"
        elif cmd == "reset":
            self.cal = dict(DEFAULT_CAL); self.ack = "Calibration reset to defaults"
        elif cmd == "interval" and value and 1 <= value <= 60:
            self.every = int(value); self.ack = f"Sending every {self.every} s"
        print("»", self.ack or f"ignored command {cmd}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", default="ABCDE", help="fleet code shown on the dashboard")
    ap.add_argument("--host", default="broker.emqx.io"); ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--http", default="", help="POST to this ingest URL instead of MQTT")
    ap.add_argument("--key", default=""); ap.add_argument("--every", type=int, default=2)
    ap.add_argument("--device", default="ESP32-BENCH-01"); ap.add_argument("--name", default="Bench sensor node (emulated)")
    ap.add_argument("--lat", type=float, default=5.408132); ap.add_argument("--lon", type=float, default=100.322845)
    ap.add_argument("--mud-at", type=float, default=0, help="seconds after start to add muddy water")
    ap.add_argument("--acid-at", type=float, default=0, help="seconds after start to add vinegar")
    ap.add_argument("--count", type=int, default=0)
    a = ap.parse_args()
    node = Node(a)
    base = f"aquatrace/demo/{a.code}/{a.device}"
    client = None
    if not a.http:
        import paho.mqtt.client as mqtt
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"aquatrace-emu-{random.randint(0, 99999)}")
        def on_msg(c, u, m):
            try:
                d = json.loads(m.payload); node.command(d.get("cmd", ""), d.get("value"))
            except Exception as e:
                print("bad command", e)
        client.on_message = on_msg
        client.on_connect = lambda c, u, f, rc, p=None: (c.subscribe(base + "/cmd"), print(f"MQTT connected to {a.host}:{a.port}, publishing on {base}/readings"))
        client.connect(a.host, a.port, keepalive=30); client.loop_start()
    sent, t0, mud_done, acid_done = 0, time.time(), False, False
    last = 0.0
    while not a.count or sent < a.count:
        node.sample()
        el = time.time() - t0
        if a.mud_at and not mud_done and el >= a.mud_at: node.mud += 180; mud_done = True; print("· added muddy water")
        if a.acid_at and not acid_done and el >= a.acid_at: node.acid += 1.6; acid_done = True; print("· added vinegar")
        if time.time() - last >= node.every:
            last = time.time()
            body = json.dumps(node.payload())
            if client:
                client.publish(base + "/readings", body)
            else:
                import urllib.request
                req = urllib.request.Request(a.http, data=body.encode(), headers={"Content-Type": "application/json", "X-Device-Id": a.device, "X-API-Key": a.key})
                try:
                    urllib.request.urlopen(req, timeout=10)
                except Exception as e:
                    print("HTTP failed:", e)
            sent += 1
            print(body[:160])
        time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())
