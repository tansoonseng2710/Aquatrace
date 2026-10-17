# AquaTrace: AI-assisted real-time water quality and micropollutant monitoring

A working prototype of the monitoring platform: continuous sensor data, HPLC reference results, machine-learning screening estimates, GPS-based pollution investigation, photocatalytic reactor evaluation and the pharmaceutical-disposal research strand in one system.

## Live website and quick start

- **Website (GitHub Pages):** https://tansoonseng2710.github.io/Aquatrace/ (runs fully in the browser with the saved model; demo data)
- **On a Windows laptop (website + ML API):** double-click `start_local.bat`, then open http://localhost:5500. Details: [`ML_API_SETUP.md`](ML_API_SETUP.md)
- **AI screening pages** (left menu): ① Live data · ② Upload data · ③ Select model · ④ Results & figures
- **Train the model:** [`colab/AquaTrace_Estimation_Model_Demo.ipynb`](colab/AquaTrace_Estimation_Model_Demo.ipynb) (Google Colab: three phases split by river site, 7 algorithms compared, full metrics, export for the website)

**Screening model, testing set (5,248 lab results from US rivers the model never saw):** random forest, ROC-AUC 0.70–0.87, mAP 0.40 vs 0.12 for random picks, precision 27% vs 9% at random (3.2× more polluted samples per lab test).

| Folder | What it is |
|---|---|
| `frontend/` | The website: one page built from `frontend/src/` by `build.sh` |
| `ml_api/` | The ML API (FastAPI; `serve_basic.py` runs the same model with no install) |
| `colab/` | Google Colab notebooks: train, validate, test and export the model |
| `backend/` | Full server: database, MQTT, sensor ingest API (optional) |
| `firmware/` | ESP32 / Arduino sensor-node code |
| `tools/`, `samples/` | Device simulator, serial bridge, example CSV files |
| `AquaTrace_Master_Data.xlsx` | 28,046 paired US river samples (US Water Quality Portal) used for training |

**Scientific positioning, enforced throughout the UI and API**

| Component | Role |
|---|---|
| HPLC | Analytical reference. Identifies and quantifies specific compounds. Never replaced. |
| Sensors | Continuous real-time bulk measurements (pH, ORP, turbidity, UV254, T, EC, DO). Cannot identify individual micropollutants. |
| Machine learning | Relationship modelling. Every output is labelled as a screening estimate with a 95 % interval and a confidence level. |
| GPS | Spatial investigation: where abnormal readings occur and whether they repeat. |
| Photocatalytic reactor | Experimental treatment evaluation. The verdict is computed from runs and controls; the system does not assume the reactor works. |

---

## 1. Run it

### 0. Website + ML model on a Windows laptop (quickest)
Double-click `start_local.bat`. It starts the **ML API** (the screening model as a web service, `ml_api/`, http://localhost:7860) and the **website** (http://localhost:5500) and opens the Estimation model page. The top bar shows **Model: online** when the website is talking to the ML API. To run the model online (Vercel, free) and connect the website to it, follow `ML_API_SETUP.md`.

### A. Just look at it (no install)
Open `frontend/index.html` in a browser. With no backend it runs a built-in simulator of a boat moving along Sungai Pinang and the George Town coast, with 7 days of synthetic history. Every feature works in this mode, including model training (in the browser).

### B. Local server with demo data (Python 3.10+)
```bash
cd backend
pip install -r requirements.txt
python -m app.seed --demo --days 7       # synthetic readings, HPLC, reactor runs, survey; trains the first models
uvicorn app.main:app --port 8000
# second terminal: a simulated sensor node posting through the real ingest API
python ../tools/device_simulator.py --every 5
```
Dashboard: http://localhost:8000 · API docs (Swagger): http://localhost:8000/docs

### Deploy the dashboard to Vercel
The repo includes `vercel.json` and `.vercelignore`, so Vercel serves only `frontend/` as a static site (no build step). On Vercel the dashboard runs in demo mode with the in-browser simulator. To show real data, run the API somewhere that can host a database and MQTT (section C), then open **Settings → Connect** on the Vercel site and enter the API address ending in `/api` (for example `https://monitor.example.org/api`); set `CORS_ORIGINS` on the API to your Vercel domain.

- **From GitHub (recommended):** push the repo, then on vercel.com choose *Add New → Project*, import `water_zoomed`, keep the detected settings (Framework: Other) and press *Deploy*. Every later push redeploys automatically.
- **From your computer:** `npx vercel` in the repo folder (log in when asked), then `npx vercel --prod`.

If you edit anything in `frontend/src/`, run `sh frontend/build.sh` before committing, since Vercel serves the built `frontend/index.html`.

### C. Production stack (Docker)
```bash
cp .env.example .env          # set API_KEY, DEVICE_KEYS, POSTGRES_PASSWORD
docker compose up -d --build  # API + dashboard, PostgreSQL 16, Mosquitto MQTT broker
```
Put it behind HTTPS (Caddy, nginx or a cloud load balancer) before exposing it. The reference compound list and potential sources load automatically on first start; demo data is only added if you run `docker compose exec api python -m app.seed --demo`.

### Tests
```bash
cd backend && pytest -q
```
Covers unit conversion, geodesy, HPLC-to-sensor matching, the anomaly baseline, reactor kinetics and verdict logic, ML uncertainty and applicability domain, CSV import of the sample files, and an API round trip. The stack has also been run end to end on PostgreSQL 16.

---

## Demo day: phones as fishing boats

The **Fishing fleet** page shows six simulated fishing boats on their grounds between George Town and the mainland, the survey boat, and any phone that joins. Following a boat makes it drive the Overview, Trends, Map and Events pages.

**Before the session**
1. Deploy to Vercel (or run the API on an HTTPS address). Phones need HTTPS for location.
2. Open the dashboard on the projector, go to **Fishing fleet**, and check the connection pill says *Connected, listening for phones*. The fleet code and QR code are on the same panel.
3. Scan the QR code with your phone, allow location, choose a position source, tap **Start sending**.

**Position sources on the phone**
| Source | When to use |
|---|---|
| Phone GPS | Outdoors or on a real boat. Indoors, GPS can be hundreds of metres off. |
| On Penang map | Indoor demos: places the phone at the Sungai Pinang river mouth and moves it as you walk (×15). |
| Simulated route | Anywhere, no GPS needed: follows the Sungai Pinang survey route. |

**The moment that sells it:** tap **Simulate discharge** on the phone (or *Simulate discharge* on that boat's card on the dashboard). Within about 20 seconds the simulated UV rises and ORP and dissolved oxygen fall, the model estimate crosses the screening level, and the dashboard raises *Possible contamination* at the phone's position, with the place name and nearby facilities on the Events page.

**If the network or GPS fails:** *Play the sample trip* on the Fishing fleet page replays a recorded run down Sungai Pinang with a discharge plume near Kampung Rawa. Trips recorded on a phone (*Download this trip*) can be loaded the same way.

**How phones connect**
- *Public message broker (default):* phone and dashboard meet on a free public MQTT broker (EMQX, HiveMQ or Mosquitto test servers) under the fleet code. No server needed, works from Vercel. Anyone who knows the code can see the readings, so use it for demonstrations only.
- *AquaTrace server:* the phone posts to `/api/ingest` (set the server address and device key under *Connection and settings*, or open `/boat?api=https://your-server/api`). Readings then go through the full pipeline: stored, scored by the server models, grouped into events, and listed by `GET /api/devices`.
- The phone keeps the screen awake while sending, buffers readings when the connection drops, and sends them when it returns.

Sensor values on the phone are simulated from the same model as the demo data; only the position is real. Real boats use the ESP32 node in `firmware/`, which posts the same JSON.

---

## Real hardware: bench node (pH + turbidity)

Two versions of the same bench node, both with a PH-4502C pH module and a TS-300B turbidity sensor (optional DS18B20 for water temperature). Their readings appear on the **Sensor node** page: live values and charts, markers for "what I just did to the water", session statistics with CSV download, and calibration buttons that send commands back to the node. The node also appears on the Fishing fleet page.

| | Arduino Nano (classic) | ESP32 |
|---|---|---|
| Firmware | [`firmware/aquatrace_nano_node`](firmware/aquatrace_nano_node/README.md) | [`firmware/aquatrace_bench_node`](firmware/aquatrace_bench_node/README.md) |
| Wiring | PO → **A0**, A → **A1**, both modules on 5V/GND, **no dividers** | PO → GPIO34, A → GPIO35, each through a 10 kΩ / 10 kΩ divider |
| Gets to the dashboard | USB cable: **Connect USB device** on the Sensor node page (Chrome/Edge), or `python tools/serial_bridge.py --code <FLEET_CODE>` to forward it to the broker | Wi-Fi → MQTT broker |
| Libraries | none | PubSubClient, ArduinoJson |

The node sends only what it measures. The model needs all seven parameters, so no paracetamol estimate is made from pH and turbidity; the Overview says so when it follows this node. To rehearse without hardware, press **Start a simulated node**, or run `python tools/esp32_emulator.py --code <FLEET_CODE>`.

---

## 2. Moving from demo to real data

1. **Remove the synthetic data**: `python -m app.seed --purge-demo` (deletes rows tagged `origin=demo`, the demo vessel's readings, events and models; keeps compounds and sources).
2. **Connect sensors** (section 3).
3. **Upload HPLC results** on the *HPLC data* page (CSV or manual form) or `POST /api/hplc/csv`. Each result is matched to sensor readings within ±15 min and 300 m (configurable).
4. **Train** on the *Machine learning* page once a compound has ≥ 12 paired samples (30+ recommended). Training through the API with `{"compound":"PCM","by_station":true}` validates by station (GroupKFold), which gives an honest estimate of performance at locations the model has not seen.
5. **Edit potential sources** and **compounds** to your site. Compounds are database rows: add a new pharmaceutical (or microplastic counts in `particles/L`) and it becomes available to import, matching, training and alerts without code changes.

Sample files for every import are in `samples/`.

---

## 3. Connecting sensors

Any device that can send JSON works. Each reading:
```json
{"device":"BOAT-01","ts":"2026-09-29T09:15:00+08:00","lat":5.4081,"lon":100.3228,
 "ph":7.21,"orp":315,"turbidity":4.8,"uv":0.37,"temp":29.3,"conductivity":640,"do":6.1}
```
- **HTTPS**: `POST /api/ingest` with header `X-API-Key: <device key>`. A JSON array is accepted, so a node can upload a backlog after losing signal.
- **MQTT**: publish to `aquatrace/<device>/readings` (enabled when `MQTT_HOST` is set; docker-compose does this).
- Extra fields (e.g. `hdop`, `speed_kn`, a chlorophyll channel) are stored with the reading.

`firmware/aquatrace_node/aquatrace_node.ino` is an ESP32 sketch for the boat: two ADS1115 ADCs for the analogue probes, DS18B20 temperature, an RS-485 Modbus UV254 probe, u-blox GPS, and an offline buffer that uploads in batches. It has not been compiled against a physical board here. Its conversion constants are placeholders and each probe must be calibrated with standards before use; the header lists the procedure.

Every reading is scored on arrival (rolling baseline per device and salinity zone, all trained models, status), grouped into pollution events, and alerts are pushed to `ALERT_WEBHOOK_URL` (Slack, Teams or any webhook). Each event is enriched with the previous 24 h rainfall from Open-Meteo (free, no key), because rain changes turbidity and dilution.

### OpenStreetMap
All maps use OpenStreetMap tiles through Leaflet; if tiles cannot load (offline laptop on the boat, blocked network) the dashboard switches automatically to a built-in schematic basemap, and the map page has an OpenStreetMap / Schematic toggle. Two OSM APIs support pollution-source investigation:

| API | Used for | Endpoint here |
|---|---|---|
| Nominatim (reverse geocoding) | Place name for every event and map selection ("Jalan Sungai Pinang, Kampung Rawa, George Town"); added to alert messages with an OSM link | `GET /api/geo/reverse?lat=&lon=` |
| Overpass | Hospitals, clinics, pharmacies, wastewater plants, outfalls, drains, veterinary clinics and industrial areas within 0.5–2 km of an event or selection; any of them can be added as a potential source with one click | `GET /api/geo/facilities?lat=&lon=&radius=` |

The backend follows the OSM usage policies: identifying User-Agent (set `OSM_CONTACT` to your email), at most one Nominatim request per second, and a 7-day cache. For heavy or commercial use, point `OSM_TILE_URL`, `OSM_NOMINATIM_URL` and `OSM_OVERPASS_URL` at your own instances or a hosted provider. With no backend (demo file), the browser calls the public endpoints directly. Everything fails soft: monitoring never depends on OSM being reachable.

---

## 4. What each page does

| Page | Contents |
|---|---|
| Overview | One plain-language status sentence with the next step, estimate with its likely range and confidence, latest lab result, sensor cards with everyday hints, the last three hours (sensor above, concentration below on one time axis), recent alerts, boat position with street name |
| Trends | Any sensor over time, with lab results and the model estimate in an aligned chart below it (no dual axes); 24 h / 3 d / 7 d |
| GIS map | OpenStreetMap basemap with the boat route, points coloured by status, hotspots (repeated abnormal events within 200 m), potential sources, HPLC samples, prior-study concentrations; click anything for its place name, an OSM link and nearby facilities |
| Pollution events | Where (coordinates and OSM place name), what changed (z-score per parameter), repeats at the location, nearest potential source, OSM facilities nearby, rainfall context, estimate, matching HPLC result, one-click sampling request |
| HPLC data | CSV upload and manual entry, unit conversion, `<LOD` handling (stored as LOD/2 and flagged), automatic time/space matching, adjustable matching rules |
| Machine learning | Pick compound, algorithm and inputs; 5-fold cross-validated R², RMSE, MAE; UV-only baseline for comparison; predicted vs measured; permutation feature importance; Pearson and Spearman correlations; per-sensor scatter; current estimate; model card |
| Micropollutant database | Compound registry with PNEC and screening levels; risk quotients from your data and from prior studies; measured concentrations at 10 points from earlier USM work |
| Photocatalytic reactor | Before → reactor → after with removal %, pseudo-first-order k and half-life, TOC removal, comparison against photolysis and dark-adsorption controls and replicates, and whether in-line sensors track HPLC-measured removal |
| Research insights | Disposal-method survey, reasons for not using take-back channels, interview notes, events near each potential source |
| Architecture | Data flow, feedback loop, deployment components |
| Settings | Connect to a server, thresholds, CSV export |

---

### Interface
Light theme by default with a light/dark switch in the top bar (it follows the system setting until you choose). Text uses Atkinson Hyperlegible, a typeface designed for low-vision readers. Chart colours are checked for colour-blind separation in both themes: river teal for sensor data, clay for lab results; status colours (green, amber, red) are reserved for states and always come with a text label.

## 5. Method notes

- **Matching**: an HPLC sample takes the weighted mean of readings within the time window and radius, weight = 1/(1+Δt[min]) × 1/(1+d/50 m). If the CSV already carries sensor columns (bench measurements), those are used directly.
- **Anomaly baseline**: exponentially weighted mean and variance per device, per salinity zone (river / estuary / coast by conductivity), so moving from river to sea is not itself an alarm. Readings beyond the threshold update the baseline at a quarter of the normal rate.
- **Models**: random forest (200 trees, depth 8) or ridge regression per compound, versioned in a registry. Uncertainty = 1.96·√(tree spread² + CV RMSE²). Confidence drops to Low when CV R² < 0.5 or any input is outside the training range ± 10 %.
- **Reactor verdict**: "supported" only if net removal beyond the best control is ≥ 20 percentage points, k is ≥ 3× the fastest control and the first-order fit has R² ≥ 0.9. Without controls it is "inconclusive". Thresholds are in `app/services/core.py`.
- **Demo realism**: in the synthetic data, paracetamol and diclofenac are recoverable from sensor patterns (CV R² ≈ 0.85–0.9) while carbamazepine and atenolol are not (R² 0.3–0.5). That spread is intentional: it shows the platform reporting weak relationships honestly rather than presenting every compound as detectable.

---

## 6. Where the reference values come from

| Used for | Source (attached documents) |
|---|---|
| Sampling points SP1–SP5 on Sungai Pinang, HPLC method (SPE, C18, 254 nm), retention times, PNEC values for DIC, CBZ, ATL, KTP | Sharifah Nurul Sofhia (2023), USM |
| Measured concentrations at 10 points (STP influent/effluent, downstream, SP1–SP5), coordinates of the Jelutong STP sampling points, RQ comparison | Amir Irham (2024), USM, compiling Khasawneh (2022), Teoh (2022), Sharifah (2023) |
| Photocatalysis benchmarks (Fe₂O₃-TiO₂ vs TiO₂ P25, 0.2 g/L optimum, 87–97 % lab removal, 79–89 % pilot, TOC ≤ 33 %, reuse and cost) and log Kow values | Khasawneh (2022), PhD thesis, USM |
| Jelutong STP as a source | Teoh Jay Kee (2022), USM |
| Treatment background | Khan et al. (eds.), *The Treatment of Pharmaceutical Wastewater*, Elsevier (2023) |

Paracetamol was not measured in those studies. Its screening level (0.15 mg/L) is a placeholder and its PNEC is deliberately left empty for you to fill from your own risk-assessment source.

---

## 7. Layout
```
backend/
  app/main.py            API (FastAPI)
  app/pipeline.py        ingest → baseline → estimate → events → alerts; training
  app/services/core.py   matching, baseline, units, reactor kinetics and verdict
  app/services/ml.py     models, cross-validation, uncertainty
  app/services/integrations.py  Open-Meteo weather, alert webhook
  app/services/osm.py    OpenStreetMap Nominatim + Overpass
  app/literature.py      prior measured concentrations
  app/mqtt.py            MQTT ingest
  app/seed.py            reference data, demo data, purge
  app/demo_world.py      synthetic water model (demo only)
  tests/
frontend/
  src/                   dashboard and phone page source; build.sh assembles index.html and boat.html
  vendor/                Chart.js, PapaParse, Leaflet (offline fallback)
firmware/aquatrace_node/        ESP32 boat node (full sensor set, untested on hardware)
firmware/aquatrace_bench_node/  ESP32 bench node, pH + turbidity over Wi-Fi
firmware/aquatrace_nano_node/   Arduino Nano bench node, pH + turbidity over USB
tools/device_simulator.py  stand-in sensor node
tools/esp32_emulator.py    stand-in ESP32 bench node (MQTT/HTTP)
tools/serial_bridge.py     forwards a USB-connected Nano to the broker or server
samples/                 example CSVs for HPLC, reactor runs and survey
docker-compose.yml, Dockerfile, .env.example, deploy/mosquitto.conf
```

## 8. Known limits of this prototype
- Single-user API key for write operations; add per-user accounts before multi-team use.
- The browser trains its own copy of each model for interactive exploration; alerts and stored estimates come from the server models.
- Survey and interview data in demo mode are invented placeholders, labelled as such.
