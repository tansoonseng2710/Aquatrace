# AquaTrace bench node: ESP32 + PH-4502C + TS-300B

Live pH and turbidity from real sensors, shown on the dashboard's **Sensor node** page and as a boat on the **Fishing fleet** page.

## Parts

| Part | Notes |
|---|---|
| ESP32 DevKit (ESP32-WROOM-32) | any board with GPIO34 and GPIO35 broken out |
| PH-4502C module + BNC pH electrode | 5 V supply, analog output PO about 2.5 V at pH 7 |
| TS-300B turbidity sensor + its adapter board | 5 V supply, analog output A up to about 4.5 V (clear water is the highest voltage) |
| 4 × 10 kΩ resistors | two voltage dividers, one per analog output |
| 2 × 100 nF capacitors (optional) | across each ADC input and GND, reduces noise |
| DS18B20 waterproof probe + 4.7 kΩ (optional) | water temperature, used for pH temperature correction |
| pH 4.00 and pH 7.00 buffers, distilled water | calibration |

## Wiring

Both modules run on 5 V and their analog outputs can exceed the ESP32's 3.3 V limit, so each output goes through a 10 kΩ / 10 kΩ divider, which halves it. Never connect PO or A straight to an ESP32 pin.

| Module pin | Connect to |
|---|---|
| PH-4502C **V+** | ESP32 **VIN** (5 V when powered over USB) |
| PH-4502C **G** (both) | ESP32 **GND** |
| PH-4502C **PO** | 10 kΩ → **GPIO34**; 10 kΩ from GPIO34 → GND |
| PH-4502C DO, TO | not connected (DO is a limit switch, TO is the board's temperature, not the water's) |
| TS-300B **VCC** | ESP32 **VIN** |
| TS-300B **GND** | ESP32 **GND** |
| TS-300B **A** | 10 kΩ → **GPIO35**; 10 kΩ from GPIO35 → GND |
| TS-300B D | not connected (threshold output) |
| DS18B20 red / black / yellow (optional) | 3V3 / GND / **GPIO4**, with 4.7 kΩ from GPIO4 to 3V3 |

```
 PH-4502C PO ──[10k]──●── GPIO34          TS-300B A ──[10k]──●── GPIO35
                      │                                       │
                    [10k]   (100 nF)                        [10k]   (100 nF)
                      │                                       │
 GND ─────────────────●──────────────     GND ────────────────●──────────────
```

Use GPIO32–39 (ADC1) for analog inputs. ADC2 pins stop working while Wi-Fi is on.

## Setup

1. Arduino IDE: install the **esp32** board package (2.x or 3.x), then the libraries **PubSubClient** (Nick O'Leary) and **ArduinoJson** (7.x). For the temperature probe also **OneWire** and **DallasTemperature**, and set `USE_DS18B20 1`.
2. Open `aquatrace_bench_node.ino` and set `WIFI_SSID`, `WIFI_PASS`, and the `FLEET_CODE` and `MQTT_HOST` shown on the dashboard's Sensor node page. Set `SITE_LAT` / `SITE_LON` to where the node is.
3. Board **ESP32 Dev Module**, upload, open the Serial Monitor at **115200** baud with line ending **Newline**. Each reading is printed as it is sent.
4. Open the dashboard's **Sensor node** page. The node appears within a few seconds.

To send to the AquaTrace server instead of (or as well as) the broker, set `USE_HTTP 1` and `API_URL` to `http://<server>/api/ingest`. Readings are then stored and listed by `GET /api/devices`; calibration buttons still need the broker.

## Calibration

Do this before any demonstration: the turbidity value is far off until the clear-water point is saved, and the dashboard shows *Not calibrated* until then.

| Step | How |
|---|---|
| pH offset (once, hardware) | Short the BNC centre to its shell (or use pH 7 buffer) and turn the blue potentiometer nearest the BNC until PO reads 2.50 V on a multimeter. |
| pH 7 point | Probe in pH 7.00 buffer, wait about a minute → **Save pH 7 buffer** on the dashboard, or `cal ph7` in the Serial Monitor |
| pH 4 point | Rinse with distilled water, probe in pH 4.00 buffer, wait → **Save pH 4 buffer** / `cal ph4`. The slope should be about 160–190 mV per pH. |
| Turbidity zero | Sensor in clear distilled water in a dark container (the sensor is optical; daylight changes the reading) → **Save clear water** / `cal clear` |
| Turbidity second point (for real NTU values) | Sensor in a reference sample of known turbidity, e.g. a formazin standard → enter the NTU and **Save reference** / `cal ref 100` |

Other commands: `reset` (factory calibration), `interval 5` (seconds between sends), `status`. Calibration is kept in the ESP32's flash.

**About the turbidity numbers.** The TS-300B has no published voltage-to-NTU curve. Until a reference point is saved, the firmware uses the widely used SEN0189 curve, shifted so this sensor's clear-water voltage reads 0 NTU. Near clear water that curve changes by about 3.7 NTU per millivolt, so expect a few NTU of jitter, and values above roughly 1,000 NTU are outside the TS-300B's rated range. For reported results, calibrate with a reference standard.

## What it sends

The same JSON as the phone transmitter, on `aquatrace/demo/<FLEET_CODE>/<DEVICE_ID>/readings` (commands arrive on `…/cmd`):

```json
{"device":"ESP32-BENCH-01","name":"Bench sensor node","kind":"esp32","fw":"1.0","seq":42,
 "ts":"2026-10-02T06:10:40Z","lat":5.408132,"lon":100.322845,"ph":7.02,"turbidity":3.4,
 "ph_mv":2496,"turb_mv":4108,"turb_cal":"clear-water","rssi":-61,"uptime_s":120,"every_s":2,
 "cal":{"ph7_mv":2500,"ph4_mv":3030,"clear_mv":4110}}
```

Only the sensors fitted are sent. The dashboard does not estimate paracetamol from pH and turbidity alone (the model needs all seven parameters), so this node shows measured values only.

## Testing without the hardware

- `python tools/esp32_emulator.py --code <FLEET_CODE>` speaks exactly this protocol, including the calibration commands. Add `--mud-at 60 --acid-at 120` for scripted water changes.
- Or press **Start a simulated node** on the Sensor node page.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| pH stuck near 0 or 14 | PO wired without the divider, or the probe is dry. Keep the probe in storage solution. |
| pH drifts when the turbidity sensor is in the same water | Ground noise. Power from a battery bank rather than a laptop, and keep wires short. |
| Turbidity jumps in daylight | The sensor is optical. Use a dark container or cover. |
| `MQTT: connection failed` | Wrong `MQTT_HOST`, or the network blocks port 1883. Try another broker or a phone hotspot. |
| Node not on the dashboard | `FLEET_CODE` and broker must match the dashboard's Fishing fleet page. |
