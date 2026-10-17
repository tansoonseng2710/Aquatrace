# AquaTrace bench node: Arduino Nano + PH-4502C + TS-300B

Live pH and turbidity from real sensors, shown on the dashboard's **Sensor node** page and as a node on the **Fishing fleet** page. This is the classic Arduino Nano (ATmega328P, 5 V) version of the ESP32 bench node. The Nano has no Wi-Fi, so readings travel over the USB cable.

## Parts

| Part | Notes |
|---|---|
| Arduino Nano (ATmega328P), original or clone | clones usually have a CH340 USB chip (install its driver on Windows/macOS if the port does not appear) |
| PH-4502C module + BNC pH electrode | 5 V supply, analog output PO about 2.5 V at pH 7 |
| TS-300B turbidity sensor + its adapter board | 5 V supply, analog output A up to about 4.5 V (clear water is the highest voltage) |
| 2 × 100 nF capacitors (optional) | from A0 and A1 to GND, reduces noise |
| DS18B20 waterproof probe + 4.7 kΩ (optional) | water temperature, used for pH temperature correction |
| pH 4.00 and pH 7.00 buffers, distilled water | calibration |
| USB cable (Mini-USB for most Nanos) | must be a data cable, not charge-only |

## Wiring

The Nano's analog inputs accept 0–5 V, the same range the modules output, so **both outputs connect directly. No voltage dividers** (unlike the ESP32 version).

| Module pin | Connect to on the Nano |
|---|---|
| PH-4502C **V+** | **5V** |
| PH-4502C **G** (both) | **GND** |
| PH-4502C **PO** | **A0** |
| PH-4502C DO, TO | not connected (DO is a limit switch, TO is the board's temperature, not the water's) |
| TS-300B **VCC** | **5V** |
| TS-300B **GND** | **GND** |
| TS-300B **A** | **A1** |
| TS-300B D | not connected (threshold output) |
| DS18B20 red / black / yellow (optional) | **5V** / **GND** / **D2**, with 4.7 kΩ from D2 to 5V |

```
                 ┌──────────── Arduino Nano ────────────┐
 PH-4502C V+ ────┤ 5V                                    │
 TS-300B VCC ────┤ 5V                                    │
 PH-4502C G  ────┤ GND                                   │
 TS-300B GND ────┤ GND                                   │
 PH-4502C PO ────┤ A0 ──(100 nF)── GND   (optional)      │
 TS-300B A   ────┤ A1 ──(100 nF)── GND   (optional)      │
 DS18B20 data ───┤ D2 ──[4.7k]── 5V      (optional)      │
                 └───────────── USB to laptop ───────────┘
```

Both modules together draw well under 100 mA, so the Nano's 5V pin powered from USB is enough.

## Setup

1. Arduino IDE → **Tools → Board: Arduino Nano**, **Processor: ATmega328P** (choose **ATmega328P (Old Bootloader)** if the upload times out, which is the case for most clones).
2. Open `aquatrace_nano_node.ino`. Set `DEVICE_ID` if you have more than one node, and `SITE_LAT` / `SITE_LON` to where it is. No libraries are needed (OneWire and DallasTemperature only if you set `USE_DS18B20 1`).
3. Upload. Open the Serial Monitor at **115200** baud with line ending **Newline**: one JSON line appears every 2 seconds.
4. **Close the Serial Monitor** before connecting the dashboard. Only one program can use the USB port.

## Getting the readings onto the dashboard

**Option 1: straight from the browser (Chrome or Edge, on the laptop the Nano is plugged into).**
Open the dashboard (the Vercel site works), go to **Sensor node** and press **Connect USB device**, then choose the Nano's port (often *USB-SERIAL CH340* or *Arduino Nano*). The Nano restarts when the port opens and its first reading appears about 3 seconds later. The calibration buttons send commands back over the same cable. If the dashboard is also connected to the broker (Fishing fleet page → Connection), it shares the readings, so phones and other laptops watching the same fleet code see the Nano too.

Web Serial needs Chrome or Edge on a computer, over `https://` or `localhost`. It does not work in Safari, Firefox or on phones, or inside an embedded preview. Open the dashboard in its own tab.

**Option 2: the serial bridge (any browser, or a laptop that just relays).**

```
pip install pyserial paho-mqtt
python tools/serial_bridge.py --code <FLEET_CODE>               # finds the port itself
python tools/serial_bridge.py --port COM5 --code <FLEET_CODE>   # Windows
python tools/serial_bridge.py --port /dev/ttyUSB0 --code <FLEET_CODE> --http http://localhost:8000/api/ingest
```

It publishes each reading to the broker (public EMQX by default, `--host` to change) on the same topic the ESP32 uses, passes calibration commands from the dashboard back to the Nano, and, with `--http`, also stores the readings on the AquaTrace server. You can type commands (`cal clear`, `status` …) into the bridge window too.

## Calibration

Do this before any demonstration: the turbidity value is far off until the clear-water point is saved, and the dashboard shows *Not calibrated* until then. Use the dashboard buttons or type the command in the Serial Monitor. Calibration is kept in the Nano's EEPROM.

| Step | How |
|---|---|
| Supply voltage (once, optional) | Measure the Nano's 5V pin with a multimeter, then `cal vcc 4980` (your value in mV). The Nano measures its own supply against its internal 1.1 V reference to convert readings to millivolts. That reference varies by about ±10 % between chips, so this step corrects it. |
| pH offset (once, hardware) | Short the BNC centre to its shell (or use pH 7 buffer) and turn the blue potentiometer nearest the BNC until PO reads 2.50 V on a multimeter. |
| pH 7 point | Probe in pH 7.00 buffer, wait about a minute → **Save pH 7 buffer** / `cal ph7` |
| pH 4 point | Rinse with distilled water, probe in pH 4.00 buffer, wait → **Save pH 4 buffer** / `cal ph4`. The slope should be about 160–190 mV per pH. |
| Turbidity zero | Sensor in clear distilled water in a dark container (the sensor is optical) → **Save clear water** / `cal clear` |
| Turbidity second point (for real NTU values) | Sensor in a reference sample of known turbidity, e.g. a formazin standard → enter the NTU and **Save reference** / `cal ref 100` |

Other commands: `reset` (factory calibration), `interval 5` (seconds between readings, 1–60), `status` (prints the current values and voltages).

**Resolution.** The Nano's ADC has 10 bits, about 4.9 mV per step at 5 V. That is about 0.03 pH per step. The firmware takes 32 samples per reading and averages the middle 16, which smooths the value to below one step. Near clear water the turbidity curve changes by about 3.7 NTU per millivolt, so expect jumps of a few NTU there until a two-point calibration is saved. The ESP32 has finer steps but a less linear ADC. For bench demonstrations both are adequate. Neither replaces a laboratory turbidimeter.

**About the turbidity numbers.** The TS-300B has no published voltage-to-NTU curve. Until a reference point is saved, the firmware uses the widely used SEN0189 curve, shifted so this sensor's clear-water voltage reads 0 NTU. Values above roughly 1,000 NTU are outside the TS-300B's rated range.

## What it sends

One JSON object per line at 115200 baud. This is the same format as the ESP32 bench node, with `kind` set to `"nano"`, a `vcc_mv` field instead of Wi-Fi signal, and no timestamp (the dashboard or the bridge adds it). Lines starting with `#` are messages for people.

```
# AquaTrace bench node (Arduino Nano). Commands: cal ph7 | cal ph4 | cal clear | cal ref <NTU> | cal vcc <mV> | reset | interval <s> | status
{"device":"NANO-BENCH-01","name":"Bench sensor node (Nano)","kind":"nano","fw":"1.0-nano","seq":2,"lat":5.408132,"lon":100.322845,"ph":7.00,"turbidity":0.0,"ph_mv":2500,"turb_mv":4104,"vcc_mv":4957,"turb_cal":"clear-water","uptime_s":4,"every_s":2,"cal":{"ph7_mv":2500,"ph4_mv":3030,"clear_mv":4104},"ack":"Clear-water point saved at 4104 mV"}
```

Commands are accepted as text (`cal ref 100`) or as JSON (`{"cmd":"cal_ref","value":100}`, which is what the dashboard and bridge send).

Memory use: about 12.9 KB of 30 KB flash and 1.1 KB of 2 KB RAM (about 15.6 KB flash with the DS18B20 option).

## Testing without the hardware

Press **Start a simulated Nano node** on the Sensor node page. It behaves like the hardware, including calibration.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No port in the Connect USB device list | Charge-only cable, or the CH340 driver is missing. Try another cable; install the CH340 driver. |
| "Could not open the port" | The Arduino Serial Monitor or the bridge is still using it. Close it. |
| Upload fails with `not in sync` | Select **ATmega328P (Old Bootloader)**. |
| pH stuck near 0 or 14 | The probe is dry or not connected, or PO is on the wrong pin. Keep the probe in storage solution. |
| pH drifts when the turbidity sensor is in the same water | Ground noise. Power the laptop from its battery rather than the charger, and keep wires short. |
| Turbidity jumps in daylight | The sensor is optical. Use a dark container or cover. |
| All voltages read a few percent off a multimeter | The internal 1.1 V reference of this chip differs from nominal. Run `cal vcc` once. Later supply changes (another USB port, a hub) are then followed automatically. |
