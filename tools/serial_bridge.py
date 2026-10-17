"""Serial bridge for the Arduino Nano bench node (firmware/aquatrace_nano_node).

The classic Nano has no Wi-Fi: it prints one JSON reading per line over USB. This script reads those
lines and forwards them to the same MQTT topics the ESP32 node and the phone transmitter use, so any
dashboard watching the fleet code (including the Vercel one on another device) shows the Nano.
Calibration buttons on the dashboard publish to .../<device>/cmd; the bridge writes them to the Nano.
You can also type commands here (cal ph7, cal clear, status ...) and they go straight to the Nano.

    pip install pyserial paho-mqtt
    python tools/serial_bridge.py --code ABCDE                          # auto-detects the port, public EMQX broker
    python tools/serial_bridge.py --port COM5 --code ABCDE              # Windows
    python tools/serial_bridge.py --port /dev/ttyUSB0 --code ABCDE --host localhost
    python tools/serial_bridge.py --port COM5 --no-mqtt --http http://localhost:8000/api/ingest   # store on the AquaTrace server

Chrome or Edge can read the Nano without this script: Sensor node page -> Connect USB device.
Close the Arduino Serial Monitor first; only one program can use the port at a time.
"""
import argparse
import json
import queue
import random
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial is needed: pip install pyserial")

USB_HINTS = ("CH340", "CH341", "FTDI", "FT232", "Arduino", "USB-SERIAL", "USB Serial", "wchusbserial", "ttyUSB", "ttyACM", "usbserial")


def find_port():
    ports = list(list_ports.comports())
    for p in ports:
        text = f"{p.device} {p.description} {p.manufacturer or ''}"
        if any(h.lower() in text.lower() for h in USB_HINTS):
            return p.device
    if len(ports) == 1:
        return ports[0].device
    names = ", ".join(p.device for p in ports) or "none"
    sys.exit(f"Could not tell which port is the Nano (ports found: {names}). Pass --port.")


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


class Bridge:
    def __init__(self, a):
        self.a = a
        self.ser = None
        self.device = None
        self.mqtt = None
        self.cmds = queue.Queue()            # lines to write to the Nano
        self.sent = 0
        self.base = f"aquatrace/demo/{a.code}" if a.code else None

    # ---------------------------------------------------------------- MQTT
    def start_mqtt(self):
        if self.a.no_mqtt:
            return
        if not self.a.code:
            sys.exit("Give the fleet code shown on the dashboard (--code), or use --no-mqtt with --http.")
        import paho.mqtt.client as mqtt
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"aquatrace-bridge-{random.randint(0, 99999)}")

        def on_connect(cl, userdata, flags, rc, props=None):
            log(f"MQTT connected to {self.a.host}:{self.a.mqtt_port} (fleet code {self.a.code})")
            if self.device:
                cl.subscribe(f"{self.base}/{self.device}/cmd")

        def on_message(cl, userdata, m):
            try:
                cmd = json.loads(m.payload.decode())
            except ValueError:
                return
            if isinstance(cmd, dict) and cmd.get("cmd"):
                log("command from dashboard:", json.dumps(cmd))
                self.cmds.put(json.dumps(cmd))

        c.on_connect, c.on_message = on_connect, on_message
        c.reconnect_delay_set(1, 10)
        c.connect_async(self.a.host, self.a.mqtt_port, keepalive=30)
        c.loop_start()
        self.mqtt = c

    def set_device(self, dev):
        if dev == self.device:
            return
        if self.mqtt and self.device:
            self.mqtt.unsubscribe(f"{self.base}/{self.device}/cmd")
        self.device = dev
        log(f"node {dev} is sending")
        if self.mqtt:
            self.mqtt.subscribe(f"{self.base}/{dev}/cmd")

    # ---------------------------------------------------------------- forwarding
    def forward(self, msg):
        msg.setdefault("ts", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        msg["via"] = "bridge"
        body = json.dumps(msg, separators=(",", ":"))
        if self.mqtt:
            self.mqtt.publish(f"{self.base}/{msg['device']}/readings", body)
        if self.a.http:
            try:
                req = urllib.request.Request(self.a.http, data=body.encode(), method="POST",
                                             headers={"Content-Type": "application/json", **({"X-API-Key": self.a.key} if self.a.key else {})})
                urllib.request.urlopen(req, timeout=5).read()
            except Exception as e:  # noqa: BLE001 — keep bridging even if the server is down
                log("HTTP post failed:", e)
        self.sent += 1

    def handle_line(self, line):
        if not line:
            return
        if line.startswith("#"):
            log("nano:", line[1:].strip())
            return
        if not line.startswith("{"):
            return
        try:
            msg = json.loads(line)
        except ValueError:
            return                                   # partial line right after opening the port
        if not isinstance(msg, dict) or not msg.get("device"):
            return
        self.set_device(msg["device"])
        self.forward(msg)
        if not self.a.quiet:
            vals = " ".join(f"{k}={msg[k]}" for k in ("ph", "turbidity", "temp") if k in msg)
            log(f"#{msg.get('seq', '?')} {vals}" + (f"  ack: {msg['ack']}" if msg.get("ack") else ""))

    # ---------------------------------------------------------------- serial
    def open_serial(self):
        port = self.a.port or find_port()
        s = serial.Serial(port, self.a.baud, timeout=0.2)
        log(f"opened {port} at {self.a.baud} baud (the Nano restarts; first reading in about 3 s)")
        return s

    def run(self):
        self.start_mqtt()
        threading.Thread(target=self.read_stdin, daemon=True).start()
        while True:
            try:
                self.ser = self.open_serial()
                buf = b""
                while True:
                    while not self.cmds.empty():
                        self.ser.write((self.cmds.get() + "\n").encode())
                    chunk = self.ser.read(256)
                    if chunk:
                        buf += chunk
                        while b"\n" in buf:
                            raw, buf = buf.split(b"\n", 1)
                            self.handle_line(raw.decode(errors="replace").strip())
                        if len(buf) > 4096:
                            buf = b""
            except serial.SerialException as e:
                log("serial port problem:", e, "- retrying in 3 s (unplugged? Serial Monitor open?)")
                try:
                    self.ser and self.ser.close()
                except Exception:  # noqa: BLE001
                    pass
                if self.a.once:
                    return
                time.sleep(3)

    def read_stdin(self):
        if not sys.stdin or not sys.stdin.isatty():
            return
        for line in sys.stdin:
            line = line.strip()
            if line:
                self.cmds.put(line)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default="", help="serial port, e.g. COM5 or /dev/ttyUSB0 (auto-detected if omitted)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--code", default="", help="fleet code shown on the dashboard")
    ap.add_argument("--host", default="broker.emqx.io", help="MQTT broker (TCP)")
    ap.add_argument("--mqtt-port", type=int, default=1883)
    ap.add_argument("--no-mqtt", action="store_true", help="do not publish to a broker")
    ap.add_argument("--http", default="", help="also POST each reading to this AquaTrace ingest URL")
    ap.add_argument("--key", default="", help="X-API-Key for --http, if the server requires one")
    ap.add_argument("--quiet", action="store_true", help="do not print each reading")
    ap.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.no_mqtt and not a.http:
        sys.exit("Nothing to forward to: drop --no-mqtt or add --http.")
    try:
        Bridge(a).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
