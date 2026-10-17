/*
  AquaTrace bench node — ESP32 + PH-4502C (pH) + TS-300B (turbidity) [+ optional DS18B20 water temperature]
  ------------------------------------------------------------------------------------------------------------
  Sends live readings to the AquaTrace dashboard in the same JSON format as the phone transmitter:
    - MQTT  (default): topic aquatrace/demo/<FLEET_CODE>/<DEVICE_ID>/readings on a public broker.
                       The dashboard's "Sensor node" and "Fishing fleet" pages pick it up when they
                       use the same fleet code and broker.
    - HTTP  (optional): POST to the AquaTrace server, <API_URL> = http(s)://<server>/api/ingest

  WIRING (both modules run on 5 V; their analog outputs go above 3.3 V, so each goes through a
  10 kΩ / 10 kΩ divider to halve it — never connect PO or A0 straight to an ESP32 pin)

    PH-4502C            ESP32
      V+   ───────────  VIN (5 V from USB)
      G    ───────────  GND          (both G pins to GND)
      G    ───────────  GND
      PO   ──[10k]──┬── GPIO34 (ADC1_CH6)      ┬ 100 nF to GND (optional, reduces noise)
                    └──[10k]── GND
      DO, TO        not connected (DO = limit switch, TO = board temperature, not water)

    TS-300B module      ESP32
      VCC  ───────────  VIN (5 V)
      GND  ───────────  GND
      A    ──[10k]──┬── GPIO35 (ADC1_CH7)      ┬ 100 nF to GND (optional)
                    └──[10k]── GND
      D             not connected (threshold output)

    DS18B20 (optional, waterproof probe, set USE_DS18B20 1)
      Red  → 3V3, Black → GND, Yellow → GPIO4 with 4.7 kΩ pull-up to 3V3

  Use ADC1 pins (GPIO32–39) only: ADC2 pins stop working while Wi-Fi is on.

  CALIBRATION (Serial Monitor at 115200 baud, line ending "Newline", or the buttons on the
  dashboard's Sensor node page). Values are kept in flash.
    pH:  1. Short the BNC (or use pH 7 buffer) and turn the blue pot nearest the BNC until PO = 2.50 V.
         2. Probe in pH 7.00 buffer, wait 1 min  →  cal ph7
         3. Rinse, probe in pH 4.00 buffer, wait →  cal ph4
    Turbidity: sensor in clear (distilled) water in a dark container → cal clear
               optional second point with a reference sample of known NTU, e.g. 100 → cal ref 100
    Other: reset (factory calibration) · interval 5 (seconds between sends) · status

  Libraries: PubSubClient (Nick O'Leary), ArduinoJson 7.x; OneWire + DallasTemperature only if USE_DS18B20.
  Board: ESP32 Dev Module, Arduino-ESP32 core 2.x or 3.x.
*/
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

// ───────────────────────────── settings ─────────────────────────────
#define USE_MQTT     1          // send to the dashboard through the MQTT broker
#define USE_HTTP     0          // also/instead POST to the AquaTrace server
#define USE_DS18B20  0          // 1 if a waterproof DS18B20 is fitted on GPIO4

const char* WIFI_SSID   = "YOUR_WIFI";
const char* WIFI_PASS   = "YOUR_PASSWORD";

const char* FLEET_CODE  = "ABCDE";              // shown on the dashboard (Fishing fleet page)
const char* MQTT_HOST   = "broker.emqx.io";     // same broker as the dashboard (EMQX / broker.hivemq.com / test.mosquitto.org)
const uint16_t MQTT_PORT = 1883;

const char* API_URL     = "http://192.168.1.50:8000/api/ingest";   // used when USE_HTTP 1
const char* DEVICE_KEY  = "";                   // must match DEVICE_KEYS on the server, if set

const char* DEVICE_ID   = "ESP32-BENCH-01";
const char* DEVICE_NAME = "Bench sensor node";
const double SITE_LAT   = 5.408132;             // fixed position (no GPS): Sungai Pinang SP2 by default
const double SITE_LON   = 100.322845;

uint32_t sendEverySec   = 2;                    // change at run time with "interval N"

// ───────────────────────────── pins & hardware ─────────────────────────────
const int   PIN_PH      = 34;
const int   PIN_TURB    = 35;
const int   PIN_DS18B20 = 4;
const int   PIN_LED     = 2;
const float DIVIDER     = 2.0f;                 // 10k/10k divider: sensor voltage = ADC voltage × 2
const char* FW_VERSION  = "1.0";

#if USE_HTTP
#include <HTTPClient.h>
#endif
#if USE_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
OneWire oneWire(PIN_DS18B20);
DallasTemperature tempProbe(&oneWire);
#endif

// ───────────────────────────── calibration ─────────────────────────────
struct Calibration {
  float ph7_mV   = 2500.0f;   // PO voltage in pH 7 buffer
  float ph4_mV   = 3030.0f;   // PO voltage in pH 4 buffer (≈ +177 mV per pH unit on most PH-4502C boards)
  float clear_mV = 4200.0f;   // TS-300B voltage in clear water
  float ref_mV   = 0.0f;      // optional second turbidity point
  float refNtu   = 0.0f;
  bool  clearDone = false;    // true once "cal clear" has been run on this sensor
} cal;
Preferences prefs;

void loadCal() {
  prefs.begin("aquatrace", true);
  cal.ph7_mV   = prefs.getFloat("ph7",   cal.ph7_mV);
  cal.ph4_mV   = prefs.getFloat("ph4",   cal.ph4_mV);
  cal.clear_mV = prefs.getFloat("clear", cal.clear_mV);
  cal.ref_mV   = prefs.getFloat("ref",   cal.ref_mV);
  cal.refNtu   = prefs.getFloat("refntu",cal.refNtu);
  cal.clearDone = prefs.getUInt("cleardone", 0) == 1;
  sendEverySec = prefs.getUInt("every",  sendEverySec);
  prefs.end();
}
void saveCal() {
  prefs.begin("aquatrace", false);
  prefs.putFloat("ph7", cal.ph7_mV);  prefs.putFloat("ph4", cal.ph4_mV);
  prefs.putFloat("clear", cal.clear_mV); prefs.putFloat("ref", cal.ref_mV); prefs.putFloat("refntu", cal.refNtu);
  prefs.putUInt("cleardone", cal.clearDone ? 1 : 0);
  prefs.putUInt("every", sendEverySec);
  prefs.end();
}

// ───────────────────────────── measurement ─────────────────────────────
float phMv = NAN, turbMv = NAN, waterTempC = NAN;   // smoothed sensor-side millivolts

// Median of 31 quick samples (rejects spikes), scaled back up through the divider.
float readSensorMv(int pin) {
  const int N = 31; uint32_t v[N];
  for (int i = 0; i < N; i++) { v[i] = analogReadMilliVolts(pin); delayMicroseconds(700); }
  for (int i = 1; i < N; i++) { uint32_t x = v[i]; int j = i - 1; while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; } v[j + 1] = x; }
  return v[N / 2] * DIVIDER;
}
float smooth(float prev, float x, float a = 0.3f) { return isnan(prev) ? x : prev + a * (x - prev); }

// pH from the two-point calibration, with Nernst temperature correction when water temperature is known.
float phFromMv(float mv, float tempC) {
  float slope = (cal.ph4_mV - cal.ph7_mV) / 3.0f;                   // mV per pH unit at calibration (25 °C)
  if (!isnan(tempC)) slope *= (tempC + 273.15f) / 298.15f;
  if (fabsf(slope) < 1.0f) return NAN;
  float ph = 7.0f - (mv - cal.ph7_mV) / slope;
  return constrain(ph, 0.0f, 14.0f);
}
// Turbidity in NTU. Two-point linear calibration when a reference sample has been recorded;
// otherwise the widely used SEN0189 curve, shifted so this sensor's clear-water voltage reads 0 NTU.
// The TS-300B has no published voltage-to-NTU curve, so values are approximate until a two-point
// calibration with a reference sample. Before "cal clear" the reading can be far off: run it first.
float ntuFromMv(float mv) {
  if (cal.refNtu > 0 && cal.ref_mV > 0 && cal.clear_mV - cal.ref_mV > 50) {
    return max(0.0f, cal.refNtu * (cal.clear_mV - mv) / (cal.clear_mV - cal.ref_mV));
  }
  auto curve = [](float v) { return -1120.4f * v * v + 5742.3f * v - 4352.9f; };
  float v = mv / 1000.0f + (4.2f - cal.clear_mV / 1000.0f);
  if (v >= 4.2f) return 0.0f;
  if (v < 2.5f) v = 2.5f;                                              // curve is valid 2.5–4.2 V
  return max(0.0f, curve(v) - curve(4.2f));                            // clear water reads exactly 0
}

// ───────────────────────────── network ─────────────────────────────
WiFiClient net;
PubSubClient mqtt(net);
char topicReadings[96], topicCmd[96];
String pendingAck = "";
uint32_t seq = 0;
String backlog[30]; int backlogCount = 0;          // readings kept while the broker is unreachable

bool timeValid() { return time(nullptr) > 1700000000; }
void isoTime(char* out, size_t n) { time_t t = time(nullptr); strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", gmtime(&t)); }

void ensureWifi() {
  static uint32_t lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastTry < 10000 && lastTry) return;
  lastTry = millis();
  Serial.printf("Wi-Fi: connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void handleCommand(String cmd, float arg);
void onMqtt(char* topic, byte* payload, unsigned int len) {
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  String cmd = d["cmd"] | "";
  handleCommand(cmd, d["value"] | NAN);
}
void ensureMqtt() {
#if USE_MQTT
  static uint32_t lastTry = 0;
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastTry < 5000 && lastTry) return;
  lastTry = millis();
  String cid = String("aquatrace-") + DEVICE_ID + "-" + String((uint32_t)esp_random(), HEX);
  if (mqtt.connect(cid.c_str())) {
    mqtt.subscribe(topicCmd);
    Serial.printf("MQTT: connected to %s, publishing on %s\n", MQTT_HOST, topicReadings);
    while (backlogCount > 0) { mqtt.publish(topicReadings, backlog[0].c_str()); for (int i = 1; i < backlogCount; i++) backlog[i - 1] = backlog[i]; backlogCount--; }
  } else {
    Serial.printf("MQTT: connection failed (state %d), retrying\n", mqtt.state());
  }
#endif
}

String buildPayload() {
  JsonDocument d;
  d["device"] = DEVICE_ID; d["name"] = DEVICE_NAME; d["kind"] = "esp32"; d["fw"] = FW_VERSION; d["seq"] = ++seq;
  if (timeValid()) { char ts[32]; isoTime(ts, sizeof ts); d["ts"] = ts; }
  d["lat"] = SITE_LAT; d["lon"] = SITE_LON;
  float ph = phFromMv(phMv, waterTempC);
  if (!isnan(ph)) d["ph"] = serialized(String(ph, 2));
  d["turbidity"] = serialized(String(ntuFromMv(turbMv), 1));
  if (!isnan(waterTempC)) d["temp"] = serialized(String(waterTempC, 1));
  d["ph_mv"] = (int)roundf(phMv); d["turb_mv"] = (int)roundf(turbMv);
  d["turb_cal"] = (cal.refNtu > 0 && cal.ref_mV > 0) ? "two-point" : cal.clearDone ? "clear-water" : "default";   // dashboard warns on "default"
  d["rssi"] = WiFi.RSSI(); d["uptime_s"] = millis() / 1000; d["every_s"] = sendEverySec;
  JsonObject c = d["cal"].to<JsonObject>();
  c["ph7_mv"] = (int)cal.ph7_mV; c["ph4_mv"] = (int)cal.ph4_mV; c["clear_mv"] = (int)cal.clear_mV;
  if (cal.refNtu > 0) { c["ref_mv"] = (int)cal.ref_mV; c["ref_ntu"] = cal.refNtu; }
  if (pendingAck.length()) { d["ack"] = pendingAck; pendingAck = ""; }
  String out; serializeJson(d, out); return out;
}

void sendReading() {
  String body = buildPayload();
  Serial.println(body);
  digitalWrite(PIN_LED, HIGH);
#if USE_MQTT
  if (mqtt.connected()) mqtt.publish(topicReadings, body.c_str());
  else if (backlogCount < 30) backlog[backlogCount++] = body;
  else { for (int i = 1; i < 30; i++) backlog[i - 1] = backlog[i]; backlog[29] = body; }
#endif
#if USE_HTTP
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http; http.begin(API_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id", DEVICE_ID);
    if (strlen(DEVICE_KEY)) http.addHeader("X-API-Key", DEVICE_KEY);
    int code = http.POST(body);
    if (code != 201 && code != 200) Serial.printf("HTTP: server answered %d\n", code);
    http.end();
  }
#endif
  digitalWrite(PIN_LED, LOW);
}

// ───────────────────────────── commands (Serial and dashboard) ─────────────────────────────
void ack(const String& m) { pendingAck = m; Serial.println("» " + m); }
void handleCommand(String cmd, float arg) {
  cmd.trim(); cmd.toLowerCase();
  if (cmd == "cal_ph7") { cal.ph7_mV = phMv; saveCal(); ack("pH 7 point saved at " + String((int)phMv) + " mV"); }
  else if (cmd == "cal_ph4") {
    if (fabsf(phMv - cal.ph7_mV) < 60) { ack("pH 4 not saved: reading is too close to the pH 7 point. Check the buffer and wait for the reading to settle."); return; }
    cal.ph4_mV = phMv; saveCal(); ack("pH 4 point saved at " + String((int)phMv) + " mV; slope " + String((cal.ph4_mV - cal.ph7_mV) / 3.0f, 1) + " mV per pH");
  }
  else if (cmd == "cal_clear") { cal.clear_mV = turbMv; cal.ref_mV = 0; cal.refNtu = 0; cal.clearDone = true; saveCal(); ack("Clear-water point saved at " + String((int)turbMv) + " mV"); }
  else if (cmd == "cal_ref") {
    if (isnan(arg) || arg <= 0) { ack("Give the reference turbidity, e.g. cal ref 100"); return; }
    if (cal.clear_mV - turbMv < 50) { ack("Reference not saved: the sample reads almost the same as clear water."); return; }
    cal.ref_mV = turbMv; cal.refNtu = arg; saveCal(); ack("Reference point saved: " + String(arg, 0) + " NTU at " + String((int)turbMv) + " mV");
  }
  else if (cmd == "reset") { cal = Calibration(); saveCal(); ack("Calibration reset to defaults"); }
  else if (cmd == "interval") { if (arg >= 1 && arg <= 60) { sendEverySec = (uint32_t)arg; saveCal(); ack("Sending every " + String(sendEverySec) + " s"); } else ack("Interval must be 1 to 60 seconds"); }
  else if (cmd == "status") {
    Serial.printf("pH %.2f (PO %.0f mV) | turbidity %.1f NTU (A %.0f mV) | temp %.1f C\n", phFromMv(phMv, waterTempC), phMv, ntuFromMv(turbMv), turbMv, waterTempC);
    Serial.printf("cal: ph7 %.0f mV, ph4 %.0f mV, clear %.0f mV, ref %.0f mV = %.0f NTU, every %u s\n", cal.ph7_mV, cal.ph4_mV, cal.clear_mV, cal.ref_mV, cal.refNtu, sendEverySec);
  }
  else if (cmd.length()) ack("Unknown command: " + cmd + " (try: cal ph7, cal ph4, cal clear, cal ref 100, reset, interval 5, status)");
}
void readSerial() {
  static String line;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      line.trim();
      if (line.length()) {
        String c = line; c.toLowerCase(); float arg = NAN;
        int sp = c.lastIndexOf(' ');
        if (sp > 0 && isdigit(c[sp + 1])) { arg = c.substring(sp + 1).toFloat(); c = c.substring(0, sp); }
        c.replace("cal ", "cal_"); c.replace(" ", "");
        handleCommand(c, arg);
      }
      line = "";
    } else line += ch;
  }
}

// ───────────────────────────── main ─────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_PH, ADC_11db);
  analogSetPinAttenuation(PIN_TURB, ADC_11db);
#if USE_DS18B20
  tempProbe.begin(); tempProbe.setWaitForConversion(false); tempProbe.requestTemperatures();
#endif
  loadCal();
  snprintf(topicReadings, sizeof topicReadings, "aquatrace/demo/%s/%s/readings", FLEET_CODE, DEVICE_ID);
  snprintf(topicCmd, sizeof topicCmd, "aquatrace/demo/%s/%s/cmd", FLEET_CODE, DEVICE_ID);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  mqtt.setBufferSize(1024);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  ensureWifi();
  Serial.println("\nAquaTrace bench node. Commands: cal ph7 | cal ph4 | cal clear | cal ref <NTU> | reset | interval <s> | status");
}

void loop() {
  static uint32_t lastSample = 0, lastSend = 0;
  ensureWifi(); ensureMqtt();
#if USE_MQTT
  mqtt.loop();
#endif
  readSerial();
  if (millis() - lastSample >= 500) {
    lastSample = millis();
    phMv = smooth(phMv, readSensorMv(PIN_PH));
    turbMv = smooth(turbMv, readSensorMv(PIN_TURB));
#if USE_DS18B20
    float t = tempProbe.getTempCByIndex(0);
    if (t > -50 && t < 85) waterTempC = smooth(waterTempC, t, 0.5f);
    tempProbe.requestTemperatures();
#endif
  }
  if (millis() - lastSend >= sendEverySec * 1000UL) { lastSend = millis(); sendReading(); }
}
