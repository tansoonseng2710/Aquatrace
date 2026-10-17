/*
  AquaTrace sensor node (ESP32) — boat / monitoring-vessel build
  ----------------------------------------------------------------
  Reads pH, ORP, turbidity, conductivity, dissolved oxygen, temperature,
  UV254 absorbance and GPS, then posts JSON to the AquaTrace API
  (POST /api/ingest) every SAMPLE_PERIOD_S seconds. Readings taken while
  the link is down are buffered and sent as a batch when it returns.

  Reference hardware (any equivalent works; adjust the conversions):
    - ESP32 DevKit (or LilyGO T-SIM7600 for 4G)
    - 2 x ADS1115 16-bit ADC (I2C 0x48, 0x49). Do not use the ESP32's own
      ADC for probes: it is noisy and non-linear.
        ADS#1 A0 pH (DFRobot Gravity pH V2, SEN0161-V2)
        ADS#1 A1 ORP (DFRobot SEN0165)
        ADS#1 A2 Turbidity (DFRobot SEN0189 or an ISO 7027 NTU probe with 0-5 V out)
        ADS#1 A3 Conductivity (DFRobot DFR0300 K=1 for river; use a K=10 cell for estuary/sea)
        ADS#2 A0 Dissolved oxygen (DFRobot SEN0237 galvanic)
    - DS18B20 waterproof temperature probe on GPIO 4 (4.7 k pull-up)
    - UV254 absorbance probe with RS-485 Modbus RTU (e.g. industrial UV254/COD
      probes) through a MAX485 module: RX 16, TX 17, DE/RE 5.
      Register addresses differ by vendor: set UV_REG / UV_SCALE below.
    - u-blox NEO-M8N GPS on UART1: RX 26, TX 27, 9600 baud
    - Isolate each probe's supply (galvanic isolators) when several probes share
      one water body, or readings interfere.

  Libraries: Adafruit ADS1X15, OneWire, DallasTemperature, TinyGPSPlus,
             ModbusMaster, ArduinoJson (v7).

  CALIBRATION: the constants in "Calibration" are placeholders. Calibrate
  each probe with standard solutions before deployment (pH 4/7/10 buffers,
  ORP 256 mV standard, 1413 / 12880 µS/cm EC standards, 0 and 100 %
  saturation for DO, formazin NTU standards, and a blank for UV254),
  and record the dates in your lab book. Sensor drift is the main source
  of false alerts.
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <TinyGPSPlus.h>
#include <ModbusMaster.h>
#include <ArduinoJson.h>
#include <time.h>

// ------------------------------------------------------------ settings
const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* API_URL   = "https://your-server.example.org/api/ingest";
const char* DEVICE_ID = "BOAT-01";
const char* DEVICE_KEY = "replace-with-device-key";   // must match DEVICE_KEYS on the server
const uint32_t SAMPLE_PERIOD_S = 30;
const size_t   BUFFER_MAX = 240;                       // 2 h of readings at 30 s

// ------------------------------------------------------------ calibration (placeholders)
float PH_NEUTRAL_V = 1.500, PH_ACID_V = 2.032;        // probe voltage in pH 7 and pH 4 buffers
float ORP_OFFSET_MV = 0.0;                            // from a 256 mV ORP standard
float TURB_A = -1120.4, TURB_B = 5742.3, TURB_C = -4352.9;   // NTU = a·V² + b·V + c (SEN0189 curve)
float EC_K = 1.0;                                     // cell constant after 1413 µS/cm calibration
float DO_CAL_V = 1.600, DO_CAL_T = 25.0;              // saturation voltage & temperature
uint16_t UV_REG = 0x0000; float UV_SCALE = 0.001;    // vendor Modbus register & scale -> AU

// ------------------------------------------------------------ pins
#define ONE_WIRE_PIN 4
#define RS485_DE 5
#define RS485_RX 16
#define RS485_TX 17
#define GPS_RX 26
#define GPS_TX 27

Adafruit_ADS1115 ads1, ads2;
OneWire oneWire(ONE_WIRE_PIN);
DallasTemperature tempProbe(&oneWire);
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);
HardwareSerial RS485(2);
ModbusMaster uvProbe;

String buffer[BUFFER_MAX];
size_t bufHead = 0, bufCount = 0;

void preTx()  { digitalWrite(RS485_DE, HIGH); }
void postTx() { digitalWrite(RS485_DE, LOW); }

float adsVolts(Adafruit_ADS1115& a, uint8_t ch, int n = 20) {
  // median-ish: average of n reads after dropping extremes
  float s = 0, mn = 99, mx = -99;
  for (int i = 0; i < n; i++) { float v = a.computeVolts(a.readADC_SingleEnded(ch)); s += v; mn = min(mn, v); mx = max(mx, v); delay(5); }
  return (s - mn - mx) / (n - 2);
}

float readPH(float tC) {
  float v = adsVolts(ads1, 0);
  float slope = (7.0 - 4.0) / (PH_NEUTRAL_V - PH_ACID_V);
  float ph = 7.0 + slope * (v - PH_NEUTRAL_V);
  return ph + 0.003 * (tC - 25.0) * (ph - 7.0);          // simple Nernst temperature correction
}
float readORP() { return adsVolts(ads1, 1) * 1000.0 - 2000.0 + ORP_OFFSET_MV; }  // SEN0165 transfer, 2.0 V = 0 mV (check your board)
float readTurbidity() { float v = adsVolts(ads1, 2); return max(0.0f, TURB_A * v * v + TURB_B * v + TURB_C); }
float readEC(float tC) {
  float v = adsVolts(ads1, 3);
  float ec = (133.42 * v * v * v - 255.86 * v * v + 857.39 * v) * EC_K;   // µS/cm (DFR0300 curve)
  return ec / (1.0 + 0.0191 * (tC - 25.0));                                  // normalise to 25 °C
}
float readDO(float tC) {
  // Two-point-free single-point calibration at saturation; DO_sat from a Benson-Krause fit (fresh water, 1 atm)
  float v = adsVolts(ads2, 0);
  float sat = 14.652 - 0.41022 * tC + 0.007991 * tC * tC - 0.000077774 * tC * tC * tC;
  float vSat = DO_CAL_V + 0.035 * (tC - DO_CAL_T);
  return max(0.0f, v / vSat * sat);
}
bool readUV(float& au) {
  uint8_t r = uvProbe.readHoldingRegisters(UV_REG, 2);
  if (r != uvProbe.ku8MBSuccess) return false;
  uint32_t raw = ((uint32_t)uvProbe.getResponseBuffer(0) << 16) | uvProbe.getResponseBuffer(1);
  au = raw * UV_SCALE;
  return true;
}

void pumpGPS(uint32_t ms) { uint32_t t = millis(); while (millis() - t < ms) while (GPSSerial.available()) gps.encode(GPSSerial.read()); }

String isoTime() {
  if (gps.date.isValid() && gps.time.isValid() && gps.date.year() > 2020) {
    char b[32]; snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02dZ", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second());
    return String(b);
  }
  time_t now = time(nullptr);
  if (now > 1700000000) { char b[32]; strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", gmtime(&now)); return String(b); }
  return "";   // server stamps it on arrival
}

void enqueue(const String& s) {
  buffer[(bufHead + bufCount) % BUFFER_MAX] = s;
  if (bufCount < BUFFER_MAX) bufCount++; else bufHead = (bufHead + 1) % BUFFER_MAX;   // drop oldest when full
}

bool flush() {
  if (!bufCount || WiFi.status() != WL_CONNECTED) return false;
  size_t n = min(bufCount, (size_t)40);
  String body = "[";
  for (size_t i = 0; i < n; i++) { if (i) body += ","; body += buffer[(bufHead + i) % BUFFER_MAX]; }
  body += "]";
  WiFiClientSecure tls; tls.setInsecure();   // TODO: pin your server's CA with tls.setCACert(...)
  HTTPClient http;
  http.begin(tls, API_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", DEVICE_KEY);
  http.addHeader("X-Device-Id", DEVICE_ID);
  int code = http.POST(body);
  http.end();
  if (code == 201 || code == 200) { bufHead = (bufHead + n) % BUFFER_MAX; bufCount -= n; return true; }
  Serial.printf("ingest failed: HTTP %d, %u buffered\n", code, (unsigned)bufCount);
  return false;
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  ads1.begin(0x48); ads2.begin(0x49);
  ads1.setGain(GAIN_ONE); ads2.setGain(GAIN_ONE);        // ±4.096 V
  tempProbe.begin();
  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  pinMode(RS485_DE, OUTPUT); postTx();
  RS485.begin(9600, SERIAL_8N1, RS485_RX, RS485_TX);
  uvProbe.begin(1, RS485); uvProbe.preTransmission(preTx); uvProbe.postTransmission(postTx);
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(0, 0, "pool.ntp.org");
}

void loop() {
  uint32_t t0 = millis();
  pumpGPS(1500);
  if (!gps.location.isValid()) { Serial.println("waiting for GPS fix"); pumpGPS(SAMPLE_PERIOD_S * 1000 - 1500); return; }

  tempProbe.requestTemperatures();
  float tC = tempProbe.getTempCByIndex(0);
  JsonDocument d;
  d["device"] = DEVICE_ID;
  String ts = isoTime(); if (ts.length()) d["ts"] = ts;
  d["lat"] = gps.location.lat(); d["lon"] = gps.location.lng();
  d["temp"] = tC;
  d["ph"] = readPH(tC);
  d["orp"] = readORP();
  d["turbidity"] = readTurbidity();
  d["conductivity"] = readEC(tC);
  d["do"] = readDO(tC);
  float au; if (readUV(au)) d["uv"] = au;
  d["hdop"] = gps.hdop.hdop(); d["sats"] = gps.satellites.value(); d["speed_kn"] = gps.speed.knots();  // stored as extra channels

  String s; serializeJson(d, s);
  Serial.println(s);
  enqueue(s);
  if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  while (flush()) {}

  int32_t wait = SAMPLE_PERIOD_S * 1000 - (millis() - t0);
  if (wait > 0) pumpGPS(wait);
}
