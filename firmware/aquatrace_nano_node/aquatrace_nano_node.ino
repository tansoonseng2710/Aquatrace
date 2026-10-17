/*
  AquaTrace bench node — Arduino Nano (ATmega328P) + PH-4502C (pH) + TS-300B (turbidity) [+ optional DS18B20]
  ---------------------------------------------------------------------------------------------------------
  The classic Nano has no Wi-Fi, so it sends one JSON line per reading over the USB cable (115200 baud).
  Two ways to get those lines onto the AquaTrace dashboard:
    1. Chrome or Edge on the laptop the Nano is plugged into: Sensor node page → "Connect USB device".
       The calibration buttons then send commands back over the same cable.
    2. Any other setup: run  python tools/serial_bridge.py --port COM5 --code <FLEET_CODE>
       which forwards readings to the MQTT broker (and commands back to the Nano).
  The JSON is the same as the ESP32 bench node and the phone transmitter, so the dashboard treats it the same way.

  WIRING (the Nano's analog pins accept 0–5 V, so the sensors connect directly: no voltage dividers)

    PH-4502C            Arduino Nano
      V+   ───────────  5V
      G    ───────────  GND          (both G pins)
      G    ───────────  GND
      PO   ───────────  A0           (optional 100 nF from A0 to GND to reduce noise)
      DO, TO        not connected (DO = limit switch, TO = board temperature, not the water's)

    TS-300B module      Arduino Nano
      VCC  ───────────  5V
      GND  ───────────  GND
      A    ───────────  A1           (optional 100 nF from A1 to GND)
      D             not connected (threshold output)

    DS18B20 (optional waterproof probe; set USE_DS18B20 1)
      Red → 5V, Black → GND, Yellow → D2, with a 4.7 kΩ resistor from D2 to 5V

  The Nano measures its own supply voltage (USB "5 V" is often 4.6–5.1 V) and converts readings with it.
  For the best accuracy, measure the 5V pin with a multimeter once and enter it:  cal vcc 4980

  CALIBRATION (Serial Monitor at 115200 baud, line ending "Newline", or the dashboard buttons). Kept in EEPROM.
    pH:  1. Short the BNC (or use pH 7 buffer) and turn the blue pot nearest the BNC until PO = 2.50 V.
         2. Probe in pH 7.00 buffer, wait 1 min  →  cal ph7
         3. Rinse, probe in pH 4.00 buffer, wait →  cal ph4
    Turbidity: sensor in clear (distilled) water in a dark container → cal clear
               optional second point with a reference sample of known NTU, e.g. 100 → cal ref 100
    Other: cal vcc <mV> · reset · interval 5 · status
  Lines starting with '#' are messages for people; every other line is a JSON reading.

  Board: Arduino Nano (Tools → Processor: ATmega328P, or "ATmega328P (Old Bootloader)" for most clones).
  Libraries: none required; OneWire + DallasTemperature only if USE_DS18B20 is 1.
*/
#include <EEPROM.h>

// ───────────────────────────── settings ─────────────────────────────
#define USE_DS18B20 0                         // 1 if a waterproof DS18B20 is fitted on D2

const char DEVICE_ID[]   = "NANO-BENCH-01";
const char DEVICE_NAME[] = "Bench sensor node (Nano)";
const char SITE_LAT[]    = "5.408132";       // fixed position, written as text to keep every digit
const char SITE_LON[]    = "100.322845";     // (Sungai Pinang SP2 by default)
const char FW_VERSION[]  = "1.0-nano";

const uint8_t PIN_PH      = A0;
const uint8_t PIN_TURB    = A1;
const uint8_t PIN_DS18B20 = 2;

#if USE_DS18B20
#include <OneWire.h>
#include <DallasTemperature.h>
OneWire oneWire(PIN_DS18B20);
DallasTemperature tempProbe(&oneWire);
#endif

// ───────────────────────────── calibration (EEPROM) ─────────────────────────────
const uint16_t CAL_MAGIC = 0xA901;
struct Calibration {
  uint16_t magic;
  float ph7_mV, ph4_mV;     // PO voltage in pH 7 and pH 4 buffers
  float clear_mV;           // TS-300B voltage in clear water
  float ref_mV, refNtu;     // optional second turbidity point
  float bandgap_mV;         // internal 1.1 V reference, corrected by "cal vcc"
  uint8_t clearDone;        // 1 once "cal clear" has been run
  uint8_t everySec;         // seconds between readings sent
} cal;

void defaultCal() {
  cal.magic = CAL_MAGIC; cal.ph7_mV = 2500; cal.ph4_mV = 3030; cal.clear_mV = 4200;
  cal.ref_mV = 0; cal.refNtu = 0; cal.bandgap_mV = 1100; cal.clearDone = 0; cal.everySec = 2;
}
void loadCal() { EEPROM.get(0, cal); if (cal.magic != CAL_MAGIC || cal.everySec < 1 || cal.everySec > 60) { defaultCal(); EEPROM.put(0, cal); } }
void saveCal() { EEPROM.put(0, cal); }

// ───────────────────────────── measurement ─────────────────────────────
float phMv = NAN, turbMv = NAN, waterTempC = NAN, vccMv = 5000;

// Supply voltage from the internal 1.1 V reference (AVcc is the ADC reference, so this sets the scale).
float readVccMv() {
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);   // reference AVcc, input = 1.1 V bandgap
  delay(2);
  ADCSRA |= _BV(ADSC); while (bit_is_set(ADCSRA, ADSC));
  uint16_t raw = ADC;
  if (raw == 0) return 5000;
  return cal.bandgap_mV * 1023.0f / raw;
}
// 32 samples, sorted, mean of the middle 16: rejects spikes and averages below one ADC step (~4.9 mV).
float readSensorMv(uint8_t pin) {
  uint16_t v[32];
  analogRead(pin);                                       // first read after switching input is discarded
  for (uint8_t i = 0; i < 32; i++) { v[i] = analogRead(pin); delayMicroseconds(300); }
  for (uint8_t i = 1; i < 32; i++) { uint16_t x = v[i]; int8_t j = i - 1; while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; } v[j + 1] = x; }
  uint32_t s = 0; for (uint8_t i = 8; i < 24; i++) s += v[i];
  return (s / 16.0f) * vccMv / 1023.0f;
}
float smooth(float prev, float x, float a = 0.3f) { return isnan(prev) ? x : prev + a * (x - prev); }

float phFromMv(float mv, float tempC) {
  float slope = (cal.ph4_mV - cal.ph7_mV) / 3.0f;                   // mV per pH unit at 25 °C
  if (!isnan(tempC)) slope *= (tempC + 273.15f) / 298.15f;           // Nernst temperature correction
  if (fabs(slope) < 1.0f) return NAN;
  return constrain(7.0f - (mv - cal.ph7_mV) / slope, 0.0f, 14.0f);
}
// Two-point linear when a reference sample is saved; otherwise the SEN0189 curve shifted so this
// sensor's clear-water voltage reads 0 NTU. Approximate until a two-point calibration (see README).
float curveNtu(float v) { return -1120.4f * v * v + 5742.3f * v - 4352.9f; }
float ntuFromMv(float mv) {
  if (cal.refNtu > 0 && cal.ref_mV > 0 && cal.clear_mV - cal.ref_mV > 50)
    return max(0.0f, cal.refNtu * (cal.clear_mV - mv) / (cal.clear_mV - cal.ref_mV));
  float v = mv / 1000.0f + (4.2f - cal.clear_mV / 1000.0f);
  if (v >= 4.2f) return 0.0f;
  if (v < 2.5f) v = 2.5f;
  return max(0.0f, curveNtu(v) - curveNtu(4.2f));
}

// ───────────────────────────── output ─────────────────────────────
uint32_t seq = 0;
char ack[96] = "";

void setAck(const char* a, long n1 = -1, const char* b = nullptr) {    // short confirmation sent with the next reading
  snprintf(ack, sizeof ack, "%s", a);
  if (n1 >= 0) snprintf(ack + strlen(ack), sizeof ack - strlen(ack), "%ld", n1);
  if (b) snprintf(ack + strlen(ack), sizeof ack - strlen(ack), "%s", b);
  Serial.print(F("# ")); Serial.println(ack);
}
void sendReading() {
  float ph = phFromMv(phMv, waterTempC);
  Serial.print(F("{\"device\":\"")); Serial.print(DEVICE_ID);
  Serial.print(F("\",\"name\":\"")); Serial.print(DEVICE_NAME);
  Serial.print(F("\",\"kind\":\"nano\",\"fw\":\"")); Serial.print(FW_VERSION);
  Serial.print(F("\",\"seq\":")); Serial.print(++seq);
  Serial.print(F(",\"lat\":")); Serial.print(SITE_LAT); Serial.print(F(",\"lon\":")); Serial.print(SITE_LON);
  if (!isnan(ph)) { Serial.print(F(",\"ph\":")); Serial.print(ph, 2); }
  Serial.print(F(",\"turbidity\":")); Serial.print(ntuFromMv(turbMv), 1);
  if (!isnan(waterTempC)) { Serial.print(F(",\"temp\":")); Serial.print(waterTempC, 1); }
  Serial.print(F(",\"ph_mv\":")); Serial.print((long)(phMv + 0.5f));
  Serial.print(F(",\"turb_mv\":")); Serial.print((long)(turbMv + 0.5f));
  Serial.print(F(",\"vcc_mv\":")); Serial.print((long)(vccMv + 0.5f));
  Serial.print(F(",\"turb_cal\":\"")); Serial.print(cal.refNtu > 0 && cal.ref_mV > 0 ? F("two-point") : cal.clearDone ? F("clear-water") : F("default"));
  Serial.print(F("\",\"uptime_s\":")); Serial.print(millis() / 1000);
  Serial.print(F(",\"every_s\":")); Serial.print(cal.everySec);
  Serial.print(F(",\"cal\":{\"ph7_mv\":")); Serial.print((long)cal.ph7_mV);
  Serial.print(F(",\"ph4_mv\":")); Serial.print((long)cal.ph4_mV);
  Serial.print(F(",\"clear_mv\":")); Serial.print((long)cal.clear_mV);
  if (cal.refNtu > 0) { Serial.print(F(",\"ref_mv\":")); Serial.print((long)cal.ref_mV); Serial.print(F(",\"ref_ntu\":")); Serial.print(cal.refNtu, 0); }
  Serial.print('}');
  if (ack[0]) { Serial.print(F(",\"ack\":\"")); Serial.print(ack); Serial.print('"'); ack[0] = 0; }
  Serial.println('}');
}

// ───────────────────────────── commands ─────────────────────────────
// Accepts "cal ph7", "cal ref 100" … from the Serial Monitor, or {"cmd":"cal_ref","value":100} from the dashboard.
void handleCommand(const char* cmd, float arg) {
  if (!strcmp(cmd, "cal_ph7")) { cal.ph7_mV = phMv; saveCal(); setAck("pH 7 point saved at ", (long)phMv, " mV"); }
  else if (!strcmp(cmd, "cal_ph4")) {
    if (fabs(phMv - cal.ph7_mV) < 60) { setAck("pH 4 not saved: reading is too close to the pH 7 point. Wait for it to settle."); return; }
    cal.ph4_mV = phMv; saveCal(); setAck("pH 4 point saved at ", (long)phMv, " mV");
  }
  else if (!strcmp(cmd, "cal_clear")) { cal.clear_mV = turbMv; cal.ref_mV = 0; cal.refNtu = 0; cal.clearDone = 1; saveCal(); setAck("Clear-water point saved at ", (long)turbMv, " mV"); }
  else if (!strcmp(cmd, "cal_ref")) {
    if (isnan(arg) || arg <= 0) { setAck("Give the reference turbidity, e.g. cal ref 100"); return; }
    if (cal.clear_mV - turbMv < 50) { setAck("Reference not saved: the sample reads almost the same as clear water."); return; }
    cal.ref_mV = turbMv; cal.refNtu = arg; saveCal(); setAck("Reference point saved: ", (long)arg, " NTU");
  }
  else if (!strcmp(cmd, "cal_vcc")) {
    if (isnan(arg) || arg < 4000 || arg > 5500) { setAck("Give the 5V pin voltage in mV, e.g. cal vcc 4980"); return; }
    cal.bandgap_mV = cal.bandgap_mV * arg / readVccMv(); saveCal(); vccMv = readVccMv(); setAck("Supply voltage set to ", (long)arg, " mV");
  }
  else if (!strcmp(cmd, "reset")) { defaultCal(); saveCal(); setAck("Calibration reset to defaults"); }
  else if (!strcmp(cmd, "interval")) {
    if (arg >= 1 && arg <= 60) { cal.everySec = (uint8_t)arg; saveCal(); setAck("Sending every ", (long)arg, " s"); } else setAck("Interval must be 1 to 60 seconds");
  }
  else if (!strcmp(cmd, "status")) {
    Serial.print(F("# pH ")); Serial.print(phFromMv(phMv, waterTempC), 2); Serial.print(F(" (PO ")); Serial.print(phMv, 0);
    Serial.print(F(" mV) | turbidity ")); Serial.print(ntuFromMv(turbMv), 1); Serial.print(F(" NTU (A ")); Serial.print(turbMv, 0);
    Serial.print(F(" mV) | supply ")); Serial.print(vccMv, 0); Serial.println(F(" mV"));
  }
  else if (cmd[0]) setAck("Unknown command. Try: status, cal ph7, cal ph4, cal clear, cal ref 100");
}
void parseLine(char* line) {
  char cmd[16] = ""; float arg = NAN;
  if (line[0] == '{') {                                     // {"cmd":"cal_ref","value":100}
    char* c = strstr(line, "\"cmd\""); if (!c) return;
    c = strchr(c + 5, '"'); if (!c) return; c++;
    uint8_t n = 0; while (*c && *c != '"' && n < sizeof cmd - 1) cmd[n++] = *c++; cmd[n] = 0;
    char* v = strstr(line, "\"value\""); if (v) { v = strchr(v + 7, ':'); if (v) arg = atof(v + 1); }
  } else {                                                  // cal ref 100
    for (char* p = line; *p; p++) *p = tolower(*p);
    char* last = strrchr(line, ' ');
    if (last && (isdigit(last[1]) || last[1] == '.')) { arg = atof(last + 1); *last = 0; }
    uint8_t n = 0;
    for (char* p = line; *p && n < sizeof cmd - 1; p++) cmd[n++] = (*p == ' ') ? '_' : *p;
    cmd[n] = 0;
  }
  handleCommand(cmd, arg);
}
void readSerial() {
  static char buf[64]; static uint8_t len = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') { if (len) { buf[len] = 0; parseLine(buf); len = 0; } }
    else if (len < sizeof buf - 1) buf[len++] = ch;
  }
}

// ───────────────────────────── main ─────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  loadCal();
#if USE_DS18B20
  tempProbe.begin(); tempProbe.setWaitForConversion(false); tempProbe.requestTemperatures();
#endif
  vccMv = readVccMv();
  Serial.println(F("# AquaTrace bench node (Arduino Nano). Commands: cal ph7 | cal ph4 | cal clear | cal ref <NTU> | cal vcc <mV> | reset | interval <s> | status"));
}

void loop() {
  static uint32_t lastSample = 0, lastSend = 0;
  readSerial();
  if (millis() - lastSample >= 500) {
    lastSample = millis();
    vccMv = smooth(vccMv, readVccMv(), 0.2f);
    phMv = smooth(phMv, readSensorMv(PIN_PH));
    turbMv = smooth(turbMv, readSensorMv(PIN_TURB));
#if USE_DS18B20
    float t = tempProbe.getTempCByIndex(0);
    if (t > -50 && t < 85) waterTempC = smooth(waterTempC, t, 0.5f);
    tempProbe.requestTemperatures();
#endif
  }
  if (millis() - lastSend >= cal.everySec * 1000UL) {
    lastSend = millis();
    digitalWrite(LED_BUILTIN, HIGH); sendReading(); digitalWrite(LED_BUILTIN, LOW);
  }
}
