/*
  ECG optical pulse prototype — TEPT4400 phototransistor / sequence-guard revision
  Target: classic ESP32 DevKit (ESP-WROOM-32), Arduino-ESP32
  Hardware: TEPT4400 on GPIO34 with 10 kOhm pull-down, I2C SDA=21 SCL=22, DS3231, SH1106 OLED
  Backend: existing authenticated POST endpoint in secrets.h

  IMPORTANT:
  - This is prototype firmware, not an ECG-approved metering system.
  - It cannot fix an unstable battery supply or a power bank that shuts off.
  - Never attach an exposed PCB to an operational utility meter without permission.
  - TEPT4400: collector=3.3V, emitter=GPIO34, 10 kOhm GPIO34->GND.
  - Diagnostic-only mode is ON by default: optical test pulses do not increment
    persisted local totals or create new backend events.
  - Timing is best effort under FreeRTOS/Wi-Fi: 1 ms capture not guaranteed.
  - Bench-calibrate with LED and test ambient-light changes before utility use.
  - TLS certificate verification needs ECG_ROOT_CA defined in secrets.h
    before production; otherwise setInsecure() is used for prototype testing.
*/

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <RTClib.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <stdlib.h>
#include <time.h>

#include "secrets.h"  // Defines DEVICE_ID, DEVICE_SECRET and API_URL.

// ---------- Optical detection: TEPT4400, rising-edge / falling-edge validation ----------
constexpr int TEPT_PIN = 34;  // ADC1 works while Wi-Fi is connected.
// Default SAFETY MODE. Leave true while checking optical response on prototype.
// When false, confirmed pulses enter the existing persistent outbox and Render.
constexpr bool TEPT_DIAGNOSTIC_ONLY = true;

// The breadboard test had ~400 ADC peak with LED, but on-meter values vary.
// These are tunable *starting* values, not proof of meter accuracy.
constexpr int TEPT_MIN_FLASH_DELTA_ADC = 30;
constexpr int TEPT_MIN_RELEASE_DELTA_ADC = 10;
constexpr float TEPT_NOISE_MULTIPLIER = 5.0f;
constexpr float TEPT_NOISE_OFFSET = 5.0f;
constexpr float TEPT_BASELINE_ALPHA = 0.0006f; // Slow ambient tracking when OFF
constexpr float TEPT_NOISE_ALPHA = 0.001f;
constexpr unsigned long TEPT_CALIBRATION_MS = 1500;
constexpr unsigned long TEPT_RECENTER_MS = 450;
constexpr unsigned long TEPT_DIAGNOSTIC_MS = 5000;

// Validate complete flash with microsecond timing, rather than requiring 2 ms ON.
constexpr uint32_t TEPT_MIN_FLASH_US = 180;     // Reject single-sample spikes
constexpr uint32_t TEPT_MAX_FLASH_US = 300000;  // Reject sustained light (300 ms)
constexpr uint32_t TEPT_RELEASE_STABLE_US = 250;
constexpr uint32_t TEPT_REARM_US = 2000;
constexpr unsigned long MIN_PULSE_INTERVAL_MS = 100;
// Give the normal Arduino loop some CPU time, without an explicit 1 ms
// sleep after EVERY ADC reading (which would miss 1 ms optical flashes).
constexpr uint32_t TEPT_TASK_YIELD_EVERY_US = 40000;
constexpr bool PRINT_TEPT_DIAGNOSTIC = true;
// Telemetry is separate from consumption events and does not touch NVS/LittleFS.
constexpr bool ENABLE_REMOTE_TEPT_LOGS = true;
constexpr int TEPT_TELEMETRY_CONNECT_TIMEOUT_MS = 3000;
constexpr int TEPT_TELEMETRY_RESPONSE_TIMEOUT_MS = 6000;

// ---------- Intervals ----------
constexpr unsigned long WIFI_RETRY_MS = 10000;
constexpr unsigned long WIFI_SETUP_FALLBACK_MS = 30000;
constexpr unsigned long PROVISION_RESTART_DELAY_MS = 1500;
constexpr unsigned long HEARTBEAT_MS = 60000;
constexpr unsigned long CONFIG_RETRY_MS = 15000;
constexpr unsigned long NTP_POLL_MS = 2000;
constexpr unsigned long NTP_RESYNC_MS = 21600000;  // 6 hours
constexpr unsigned long OLED_REFRESH_MS = 250;
constexpr unsigned long API_STATUS_FRESH_MS = 120000;

// A free Render service may take roughly a minute to wake up.
constexpr int HTTP_CONNECT_TIMEOUT_MS = 60000;
constexpr int HTTP_RESPONSE_TIMEOUT_MS = 70000;

constexpr size_t OUTBOX_COMPACT_BYTES = 8192;
const char* OUTBOX_PATH = "/ecg_outbox.csv";
const char* DEAD_PATH = "/ecg_dead.csv";
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.google.com";

// ---------- Shared state ----------
uint32_t meterConstant = 0;
volatile bool meterConstantReady = false;
volatile bool provisioningMode = false;
volatile bool flashReady = false;
bool rtcReady = false;
volatile bool rtcTimeTrusted = false;
bool localTotalInitialized = false;
// Sequence identities are checked against the backend's lastSequence before
// replay on every connection. On first upgraded boot, hold optical events
// in the existing 128-event RAM queue until the handshake finishes.
volatile bool sequenceReady = false;
volatile uint32_t cloudPulseCount = 0;
volatile bool cloudTotalKnown = false;
volatile bool sequenceConflict = false;
volatile uint32_t teptDiagnosticCount = 0;


uint32_t localPulseCount = 0;
float energyKWh = 0.0f;
float powerKW = 0.0f;
uint64_t currentSequence = 0;
uint64_t lastSyncedSequence = 0;

unsigned long lastPulseTime = 0;
unsigned long lastHeartbeatQueued = 0;
unsigned long lastDisplayRefresh = 0;
unsigned long lastWiFiAttempt = 0;
unsigned long wifiFailureSince = 0;
unsigned long lastConfigAttempt = 0;
unsigned long lastNtpPoll = 0;
unsigned long lastNtpRtcSync = 0;
unsigned long provisionRestartAt = 0;

// NET = associated to Wi-Fi, API = an HTTP success within last two minutes.
volatile uint32_t lastApiSuccessMs = 0;

RTC_DS3231 rtc;
Preferences preferences;
WebServer setupServer(80);
U8G2_SH1106_128X64_NONAME_F_HW_I2C display(U8G2_R0, U8X8_PIN_NONE, 22, 21);

String savedWifiSsid;
String savedWifiPassword;
String setupApSsid;

struct NetworkEvent {
  uint8_t pulse;                 // 1 = optical pulse, 0 = heartbeat
  uint64_t sequence;
  char timestamp[32];
  uint32_t localTotal;
};

// Only a tiny event travels from the fast sensor task to the main loop.
// LittleFS/NVS, RTC I2C, HTTP, OLED, and Serial stay OUT of the sensor task.
struct OpticalPulse {
  uint32_t detectedAtMs;
  int adc;
};
struct TeptDiagnostic {
  int minimum;
  int maximum;
  int baseline;
  int onDelta;
  int offDelta;
  int peakDelta;
  bool armed;
  uint32_t samples;
  uint32_t candidates;
  uint32_t accepted;
  uint32_t queueDrops;
  uint32_t shortRejected;
  uint32_t longRejected;
  uint32_t saturatedSamples;
};
QueueHandle_t opticalPulseQueue = nullptr;
QueueHandle_t opticalDiagnosticQueue = nullptr;
// Latest diagnostic window only: bounded RAM queue, safe to drop if Wi-Fi is down.
QueueHandle_t remoteDiagnosticQueue = nullptr;
bool otaStarted = false;

QueueHandle_t networkQueue = nullptr;
SemaphoreHandle_t flashMutex = nullptr;
portMUX_TYPE sequenceMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE meterMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE timeMux = portMUX_INITIALIZER_UNLOCKED;

volatile bool rtcAdjustmentPending = false;
volatile uint32_t pendingRtcUnix = 0;

enum SendResult : uint8_t { SEND_OK, SEND_BAD_EVENT, SEND_AUTH_ERROR, SEND_RETRY, SEND_SEQUENCE_CONFLICT };

// ---------- Function declarations ----------
uint64_t getCurrentSequence();
uint64_t getLastSyncedSequence();
uint32_t getLocalPulseCount();
uint32_t getMeterConstant();
void markSequenceSynced(uint64_t sequence);
void makeIsoTimestamp(DateTime now, char* buffer, size_t length);
DateTime readClockOnMainCore();
void fillHeartbeat(NetworkEvent& event);
void applyPendingRtcSync();
void pollNtpOnNetworkCore();
void renderDisplay(DateTime now);
void opticalSamplingTask(void* parameter);
void handleAcceptedPulse(int lightValue, unsigned long nowMs);

bool initFlashStorage();
void ensureFlashFile(const char* path, const char* header);
bool appendFlashOutboxEvent(const NetworkEvent& event);
bool loadNextFlashOutboxEvent(NetworkEvent& event);
bool appendFlashDeadLetter(const NetworkEvent& event, const char* reason);
void recoverPersistentStateFromFlash();
void compactFlashOutboxIfSynced();

bool parseJsonUnsigned(const String& body, const char* key, uint32_t& value);
bool parseJsonSequence(const String& body, uint64_t& value);
bool verifyServerSequenceHead(const String& heartbeat);

bool applyMeterConstantFromResponse(const String& response);
SendResult postEvent(const NetworkEvent& event, String* responseOut = nullptr);
bool syncDeviceConfigViaHeartbeat();
void networkTask(void* parameter);

bool hasSavedWifiCredentials();
void startSavedWifiConnection();
void startProvisioningMode();
void stopProvisioningMode();
bool extractJsonString(const String& body, const char* key, String& value);
void configureProvisioningServer();
void setupLocalOtaIfConnected();
bool postRemoteOpticalDiagnostic(const TeptDiagnostic& diagnostic);

// ---------- Startup ----------
void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.println("\n=== ECG ESP32 TEPT4400 REMOTE-DIAGNOSTICS / LOCAL-OTA BUILD ===");
  Serial.printf("TEPT MODE: %s\n", TEPT_DIAGNOSTIC_ONLY ? "DIAGNOSTIC-ONLY (NO NEW PULSE UPLOADS)" : "LIVE (NEW PULSES TO RENDER)");
  Serial.println("NOTE: NET=Wi-Fi; API=recent successful backend response");

  Wire.begin(21, 22);
  display.setI2CAddress(0x3C * 2);
  display.begin();

  rtcReady = rtc.begin();
  if (!rtcReady) {
    Serial.println("WARNING: DS3231 RTC NOT DETECTED");
  } else if (rtc.lostPower()) {
    Serial.println("WARNING: RTC LOST POWER; WAIT FOR NTP BEFORE TRUSTING TIMESTAMPS");
  } else {
    rtcTimeTrusted = true;
    Serial.println("RTC CONNECTED");
  }

  if (!preferences.begin("ecg-meter", false)) {
    Serial.println("CRITICAL: PREFERENCES/NVS OPEN FAILED");
  }

  savedWifiSsid = preferences.getString("wifiSsid", "");
  savedWifiPassword = preferences.getString("wifiPassword", "");
  setupApSsid = String(DEVICE_ID) + "-SETUP";

  meterConstant = preferences.getUInt("meterConst", 0);
  meterConstantReady = (meterConstant >= 1 && meterConstant <= 100000);
  if (!meterConstantReady) {
    meterConstant = 0;
    Serial.println("METER CONSTANT UNSET: AWAITING SERVER CONFIG");
  }

  currentSequence = preferences.getULong64("sequence", 0);
  if (preferences.isKey("lastSynced")) {
    lastSyncedSequence = preferences.getULong64("lastSynced", 0);
  } else {
    // Migration: older pre-outbox events cannot be reconstructed.
    lastSyncedSequence = currentSequence;
    preferences.putULong64("lastSynced", lastSyncedSequence);
  }

  if (preferences.isKey("localPulses")) {
    localPulseCount = preferences.getULong("localPulses", 0);
    localTotalInitialized = true;
    if (meterConstantReady) {
      energyKWh = (float)localPulseCount / (float)meterConstant;
    }
  }

  // Older firmware could bootstrap pulse totals without bootstrapping sequence.
  // Never trust its saved sequence until the backend confirms the head.
  sequenceReady = preferences.getBool("seqV2Ready", false);
  Serial.printf("SEQ GUARD saved=%s\n", sequenceReady ? "YES" : "NO");
  Serial.printf("STATE: sequence=%llu, synced=%llu, pulses=%lu\n",
    (unsigned long long)currentSequence,
    (unsigned long long)lastSyncedSequence,
    (unsigned long)localPulseCount);

  flashMutex = xSemaphoreCreateMutex();
  if (!flashMutex) Serial.println("CRITICAL: FLASH MUTEX FAILED");

  flashReady = initFlashStorage();
  if (flashReady) {
    ensureFlashFile(OUTBOX_PATH, "sequence,pulse,timestamp,localTotal");
    ensureFlashFile(DEAD_PATH, "sequence,pulse,timestamp,localTotal,reason");
    if (flashReady) {
      recoverPersistentStateFromFlash();
      Serial.println("LITTLEFS OFFLINE OUTBOX READY");
    }
  }
  if (!flashReady) {
    Serial.println("WARNING: LITTLEFS UNAVAILABLE; RAM FALLBACK IS NOT POWER-LOSS SAFE");
  }

  networkQueue = xQueueCreate(128, sizeof(NetworkEvent));
  if (!networkQueue) Serial.println("CRITICAL: NETWORK QUEUE ALLOCATION FAILED");
  opticalPulseQueue = xQueueCreate(128, sizeof(OpticalPulse));
  opticalDiagnosticQueue = xQueueCreate(1, sizeof(TeptDiagnostic));
  remoteDiagnosticQueue = xQueueCreate(1, sizeof(TeptDiagnostic));
  if (!opticalPulseQueue || !opticalDiagnosticQueue) {
    Serial.println("CRITICAL: OPTICAL QUEUE ALLOCATION FAILED");
  }

  configureProvisioningServer();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  if (hasSavedWifiCredentials()) startSavedWifiConnection();
  else startProvisioningMode();

  BaseType_t taskCreated = xTaskCreatePinnedToCore(
    networkTask, "networkTask", 10240, nullptr, 1, nullptr, 0
  );
  if (taskCreated != pdPASS) {
    Serial.println("CRITICAL: NETWORK TASK DID NOT START");
  }

  // High-priority ADC sampling isolated from SH1106 / RTC / HTTP work.
  // Pulse handling and flash writes remain in loopTask, never this task.
  pinMode(TEPT_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(TEPT_PIN, ADC_11db);
  if (opticalPulseQueue && opticalDiagnosticQueue) {
    if (xTaskCreatePinnedToCore(opticalSamplingTask, "opticalADC", 4096,
                                nullptr, 2, nullptr, 1) != pdPASS) {
      Serial.println("CRITICAL: OPTICAL SAMPLING TASK DID NOT START");
    }
  }
  Serial.println("ECG POWER METER READY");
}

// ---------- Main loop: persist sensed events, then update screen ----------
void loop() {
  applyPendingRtcSync();
  // Password-protected Arduino network upload on the SAME local Wi-Fi.
  setupLocalOtaIfConnected();
  if (otaStarted && WiFi.status() == WL_CONNECTED) ArduinoOTA.handle();
  unsigned long nowMs = millis();

  // Optical sampling itself is independent of OLED refresh and flash writes.
  // Process multiple waiting pulses so bursts do not get delayed unnecessarily.
  OpticalPulse hit{};
  unsigned int drained = 0;
  while ((TEPT_DIAGNOSTIC_ONLY || sequenceReady) &&
         opticalPulseQueue && drained < 16 &&
         xQueueReceive(opticalPulseQueue, &hit, 0) == pdTRUE) {
    if (TEPT_DIAGNOSTIC_ONLY) {
      // Read-only sensing check: do NOT touch sequence, NVS, LittleFS,
      // local meter totals, or emit a new server pulse.
      ++teptDiagnosticCount;
      Serial.printf("TEPT TEST FLASH #%lu ADC=%d (NOT UPLOADED)\n",
                    (unsigned long)teptDiagnosticCount, hit.adc);
    } else {
      handleAcceptedPulse(hit.adc, hit.detectedAtMs);
    }
    ++drained;
  }

  TeptDiagnostic diag{};
  if (opticalDiagnosticQueue &&
      xQueueReceive(opticalDiagnosticQueue, &diag, 0) == pdTRUE) {
    if (ENABLE_REMOTE_TEPT_LOGS && remoteDiagnosticQueue)
      xQueueOverwrite(remoteDiagnosticQueue, &diag);
    if (PRINT_TEPT_DIAGNOSTIC) Serial.printf(
      "TEPT 5s: min=%d max=%d baseline=%d peakDelta=%d "
      "ONdelta=%d OFFdelta=%d armed=%s samples=%lu "
      "candidates=%lu detected=%lu dropped=%lu "
      "short=%lu long=%lu saturated=%lu\n",
      diag.minimum, diag.maximum, diag.baseline, diag.peakDelta,
      diag.onDelta, diag.offDelta, diag.armed ? "YES" : "NO",
      (unsigned long)diag.samples, (unsigned long)diag.candidates,
      (unsigned long)diag.accepted, (unsigned long)diag.queueDrops,
      (unsigned long)diag.shortRejected, (unsigned long)diag.longRejected,
      (unsigned long)diag.saturatedSamples);
  }

  if (nowMs - lastDisplayRefresh >= OLED_REFRESH_MS) {
    lastDisplayRefresh = nowMs;
    renderDisplay(readClockOnMainCore());
  }

  // Scheduled heartbeat, unchanged. Initial heartbeat still happens on Wi-Fi connect.
  if (networkQueue && nowMs - lastHeartbeatQueued >= HEARTBEAT_MS &&
      uxQueueMessagesWaiting(networkQueue) == 0 &&
      getLastSyncedSequence() >= getCurrentSequence()) {
    NetworkEvent hb{};
    hb.pulse = 0;
    hb.sequence = getCurrentSequence();
    hb.localTotal = getLocalPulseCount();
    makeIsoTimestamp(readClockOnMainCore(), hb.timestamp, sizeof(hb.timestamp));
    if (xQueueSend(networkQueue, &hb, 0) == pdTRUE) {
      lastHeartbeatQueued = nowMs;
    }
  }
  delay(1);
}

// ---------- Clock / display ----------
DateTime readClockOnMainCore() {
  if (rtcReady && rtcTimeTrusted) {
    DateTime now = rtc.now();
    if (now.year() >= 2024 && now.year() <= 2099) return now;
  }
  time_t unixNow = time(nullptr);
  if (unixNow >= 1700000000) return DateTime((uint32_t)unixNow);
  return DateTime(2000, 1, 1, 0, 0, 0);
}

void makeIsoTimestamp(DateTime now, char* buffer, size_t length) {
  snprintf(buffer, length, "%04d-%02d-%02dT%02d:%02d:%02d.000Z",
    now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
}

void fillHeartbeat(NetworkEvent& event) {
  event = NetworkEvent{};
  event.pulse = 0;
  event.sequence = getCurrentSequence();
  event.localTotal = getLocalPulseCount();
  time_t systemNow = time(nullptr);
  if (systemNow >= 1700000000) {
    makeIsoTimestamp(DateTime((uint32_t)systemNow), event.timestamp, sizeof(event.timestamp));
  } else {
    snprintf(event.timestamp, sizeof(event.timestamp), "%s", "2000-01-01T00:00:00.000Z");
  }
}

void renderDisplay(DateTime now) {
  uint32_t pulses = getLocalPulseCount();
  uint32_t k = getMeterConstant();
  display.clearBuffer();
  display.setFont(u8g2_font_5x8_tf);
  display.setCursor(0, 9);
  if (TEPT_DIAGNOSTIC_ONLY) {
    display.print("TEPT TEST #");
    display.print((unsigned long)teptDiagnosticCount);
  } else {
    display.print("ECG POWER METER");
  }
  display.setCursor(0, 21);
  display.print("Power: ");
  if (k) { display.print(powerKW, 2); display.print(" kW"); }
  else display.print("CONFIG");
  display.setCursor(0, 33);
  display.print("Energy: ");
  if (k) display.print(energyKWh, 4);
  else display.print("CONFIG");
  display.setCursor(0, 45);
  display.print("L:"); display.print(pulses);
  if (cloudTotalKnown) {
    display.print(" S:"); display.print((unsigned long)cloudPulseCount);
  } else {
    display.print(" S:?");
  }
  display.setCursor(0, 58);
  if (now.hour() < 10) display.print('0');
  display.print(now.hour()); display.print(':');
  if (now.minute() < 10) display.print('0');
  display.print(now.minute()); display.print(':');
  if (now.second() < 10) display.print('0');
  display.print(now.second());

  display.setCursor(91, 58);
  if (!sequenceReady) {
    display.print(sequenceConflict ? "HALT" : "SYNC");
  } else if (WiFi.status() == WL_CONNECTED) {
    uint32_t lastApi = lastApiSuccessMs;
    if (lastApi != 0 && (uint32_t)(millis() - lastApi) < API_STATUS_FRESH_MS) {
      display.print("API");
    } else {
      display.print("NET");
    }
  } else if (provisioningMode) {
    display.print("SET");
  } else {
    display.print("OFF");
  }
  display.sendBuffer();
}

void applyPendingRtcSync() {
  uint32_t unixTime = 0;
  portENTER_CRITICAL(&timeMux);
  if (rtcAdjustmentPending) {
    unixTime = pendingRtcUnix;
    rtcAdjustmentPending = false;
  }
  portEXIT_CRITICAL(&timeMux);
  if (unixTime && rtcReady) {
    rtc.adjust(DateTime(unixTime));
    rtcTimeTrusted = true;
    Serial.println("RTC UPDATED FROM NETWORK UTC TIME");
  }
}

void pollNtpOnNetworkCore() {
  unsigned long nowMs = millis();
  if (nowMs - lastNtpPoll < NTP_POLL_MS) return;
  lastNtpPoll = nowMs;
  time_t systemNow = time(nullptr);
  if (systemNow < 1700000000) return;  // SNTP has not completed yet.
  if (lastNtpRtcSync != 0 && nowMs - lastNtpRtcSync < NTP_RESYNC_MS) return;
  lastNtpRtcSync = nowMs;
  portENTER_CRITICAL(&timeMux);
  pendingRtcUnix = (uint32_t)systemNow;
  rtcAdjustmentPending = true;
  portEXIT_CRITICAL(&timeMux);
  Serial.println("VALID NTP TIME RECEIVED; RTC UPDATE SCHEDULED");
}

// ---------- TEPT4400 pulses: high-priority ADC sampling task on core 1 ----------
// Only an optical waveform is measured here. No I2C, Wi-Fi, file writes,
// Preferences or Serial activity occur in this task.
void opticalSamplingTask(void* parameter) {
  (void)parameter;
  float baseline = (float)analogRead(TEPT_PIN);
  float noise = 1.5f;
  bool armed = false;
  bool pulseHigh = false;
  bool releaseCandidate = false;
  bool lowCandidate = false;
  uint32_t pulseStartUs = 0;
  uint32_t releaseStartUs = 0;
  uint32_t lowSinceUs = 0;
  uint32_t lastAcceptedMs = 0;
  uint32_t startMs = millis();
  uint32_t lastNearBaselineMs = startMs;
  uint32_t lastReportMs = startMs;
  uint32_t lastYieldUs = micros();
  int minAdc = 4095, maxAdc = 0;
  int peakDelta = 0;
  int candidatePeak = 0;
  uint32_t samples = 0, candidates = 0, accepted = 0, drops = 0;
  uint32_t shortRejected = 0, longRejected = 0, saturatedSamples = 0;

  while (true) {
    const uint32_t nowUs = micros();
    const uint32_t nowMs = millis();
    const int adc = analogRead(TEPT_PIN);
    ++samples;
    if (adc < minAdc) minAdc = adc;
    if (adc > maxAdc) maxAdc = adc;
    if (adc >= 4090) ++saturatedSamples;

    if ((uint32_t)(nowMs - startMs) < TEPT_CALIBRATION_MS) {
      // No meter events during the initial ambient-light calibration.
      const float diff = (float)adc - baseline;
      baseline += 0.0025f * diff;
      noise += TEPT_NOISE_ALPHA * (fabsf(diff) - noise);
      if (noise < 0.5f) noise = 0.5f;
    } else {
      const float signal = (float)adc - baseline; // TEPT emitter voltage rises in light
      const int onDelta = max(TEPT_MIN_FLASH_DELTA_ADC,
                              (int)(noise * TEPT_NOISE_MULTIPLIER + TEPT_NOISE_OFFSET));
      const int offDelta = max(TEPT_MIN_RELEASE_DELTA_ADC, onDelta / 3);
      if (signal > (float)peakDelta) peakDelta = (int)signal;

      if (pulseHigh) {
        if (adc > candidatePeak) candidatePeak = adc;
        if (signal <= (float)offDelta) {
          if (!releaseCandidate) {
            releaseCandidate = true;
            releaseStartUs = nowUs;
          } else if ((uint32_t)(nowUs - releaseStartUs) >= TEPT_RELEASE_STABLE_US) {
            // Measure the HIGH interval at the beginning of the confirmed
            // falling edge; don't count the trailing stable-LOW delay.
            const uint32_t widthUs = (uint32_t)(releaseStartUs - pulseStartUs);
            pulseHigh = false;
            releaseCandidate = false;
            armed = false;
            lowCandidate = true;
            lowSinceUs = releaseStartUs;

            if (widthUs >= TEPT_MIN_FLASH_US &&
                widthUs <= TEPT_MAX_FLASH_US &&
                (lastAcceptedMs == 0 ||
                 (uint32_t)(nowMs - lastAcceptedMs) >= MIN_PULSE_INTERVAL_MS)) {
              lastAcceptedMs = nowMs;
              OpticalPulse hit{nowMs, candidatePeak};
              if (opticalPulseQueue &&
                  xQueueSend(opticalPulseQueue, &hit, 0) == pdTRUE) ++accepted;
              else ++drops;
            } else if (widthUs < TEPT_MIN_FLASH_US) {
              ++shortRejected;
            }
          }
        } else {
          releaseCandidate = false;
        }
        // Ignore steady ambient-light steps; never count them as energy pulses.
        if (pulseHigh &&
            (uint32_t)(nowUs - pulseStartUs) > TEPT_MAX_FLASH_US) {
          pulseHigh = false;
          releaseCandidate = false;
          armed = false;
          lowCandidate = false;
          ++longRejected;
        }
      } else if (!armed) {
        if (signal <= (float)offDelta) {
          if (!lowCandidate) { lowCandidate = true; lowSinceUs = nowUs; }
          if ((uint32_t)(nowUs - lowSinceUs) >= TEPT_REARM_US) {
            armed = true;
            lowCandidate = false;
          }
        } else {
          lowCandidate = false;
        }
      } else if (signal >= (float)onDelta) {
        pulseHigh = true;
        armed = false;
        releaseCandidate = false;
        pulseStartUs = nowUs;
        candidatePeak = adc;
        ++candidates;
      }

      // Track slowly varying background ONLY outside a pulse; otherwise the
      // baseline could catch a millisecond flash before its falling edge.
      if (!pulseHigh && signal <= (float)offDelta) {
        lastNearBaselineMs = nowMs;
        const float diff = (float)adc - baseline;
        baseline += TEPT_BASELINE_ALPHA * diff;
        noise += TEPT_NOISE_ALPHA * (fabsf(diff) - noise);
        if (noise < 0.5f) noise = 0.5f;
      } else if (!pulseHigh &&
                 (uint32_t)(nowMs - lastNearBaselineMs) > TEPT_RECENTER_MS) {
        // If room illumination changed and stayed changed, shift the baseline.
        baseline += 0.0004f * ((float)adc - baseline);
      }
    }

    if ((uint32_t)(nowMs - lastReportMs) >= TEPT_DIAGNOSTIC_MS) {
      const int onDelta = max(TEPT_MIN_FLASH_DELTA_ADC,
                              (int)(noise * TEPT_NOISE_MULTIPLIER + TEPT_NOISE_OFFSET));
      TeptDiagnostic diag{};
      diag.minimum = minAdc;
      diag.maximum = maxAdc;
      diag.baseline = (int)baseline;
      diag.onDelta = onDelta;
      diag.offDelta = max(TEPT_MIN_RELEASE_DELTA_ADC, onDelta / 3);
      diag.peakDelta = peakDelta;
      diag.armed = armed;
      diag.samples = samples;
      diag.candidates = candidates;
      diag.accepted = accepted;
      diag.queueDrops = drops;
      diag.shortRejected = shortRejected;
      diag.longRejected = longRejected;
      diag.saturatedSamples = saturatedSamples;
      if (opticalDiagnosticQueue) xQueueOverwrite(opticalDiagnosticQueue, &diag);
      minAdc = 4095; maxAdc = 0; peakDelta = 0;
      samples = candidates = accepted = drops = 0;
      shortRejected = longRejected = saturatedSamples = 0;
      lastReportMs = nowMs;
    }

    // Yield periodically for the OLED/main loop. This is best effort and a
    // short RTOS scheduling gap can still miss a 1 ms flash. Do not market
    // this as guaranteed 1 ms capture without a comparator/interrupt.
    if ((uint32_t)(nowUs - lastYieldUs) >= TEPT_TASK_YIELD_EVERY_US) {
      vTaskDelay(1);
      lastYieldUs = micros();
    }
  }
}

void handleAcceptedPulse(int lightValue, unsigned long nowMs) {
  DateTime now = readClockOnMainCore();
  uint32_t total;
  portENTER_CRITICAL(&meterMux);
  ++localPulseCount;
  total = localPulseCount;
  portEXIT_CRITICAL(&meterMux);

  uint64_t sequence;
  portENTER_CRITICAL(&sequenceMux);
  sequence = ++currentSequence;
  portEXIT_CRITICAL(&sequenceMux);

  uint32_t k = getMeterConstant();
  if (k) {
    energyKWh = (float)total / (float)k;
    if (lastPulseTime) {
      unsigned long dt = nowMs - lastPulseTime;
      if (dt) powerKW = 3600000.0f / ((float)k * (float)dt);
    }
  } else {
    energyKWh = 0.0f;
    powerKW = 0.0f;
  }
  lastPulseTime = nowMs;

  NetworkEvent event{};
  event.pulse = 1;
  event.sequence = sequence;
  event.localTotal = localTotalInitialized ? total : 0;
  makeIsoTimestamp(now, event.timestamp, sizeof(event.timestamp));

  // Append to nonvolatile LittleFS before treating pulse as queued for cloud.
  bool durable = flashReady && appendFlashOutboxEvent(event);
  if (!durable) Serial.println("WARNING: NONVOLATILE OUTBOX FAILED; TRYING RAM QUEUE");

  // These NVS writes retain event identity / cumulative count through reset.
  preferences.putULong64("sequence", sequence);
  if (localTotalInitialized) preferences.putULong("localPulses", total);

  if (!durable) {
    if (!networkQueue || xQueueSend(networkQueue, &event, 0) != pdTRUE) {
      Serial.println("CRITICAL: PULSE COULD NOT BE QUEUED — DATA MAY BE LOST");
    }
  }

  Serial.printf("PULSE seq=%llu total=%lu ADC=%d power=%.3f kW flash=%s\n",
    (unsigned long long)sequence, (unsigned long)total, lightValue,
    (double)powerKW, durable ? "YES" : "NO");
}

// ---------- Backend POST ----------
SendResult postEvent(const NetworkEvent& event, String* responseOut) {
  if (WiFi.status() != WL_CONNECTED) return SEND_RETRY;
  if (!String(API_URL).startsWith("https://")) {
    Serial.println("ERROR: API_URL MUST BEGIN WITH https://");
    return SEND_RETRY;
  }

  WiFiClientSecure client;
#ifdef ECG_ROOT_CA
  client.setCACert(ECG_ROOT_CA);
#else
  client.setInsecure();  // For testing only: does NOT verify Render TLS identity.
#endif
  HTTPClient http;
  http.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
  http.setTimeout(HTTP_RESPONSE_TIMEOUT_MS);
  if (!http.begin(client, API_URL)) {
    Serial.println("HTTP BEGIN FAILED");
    return SEND_RETRY;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_SECRET);

  char body[256];
  int len = snprintf(body, sizeof(body),
    "{\"deviceId\":\"%s\",\"pulse\":%u,\"sequence\":%llu,\"timestamp\":\"%s\"}",
    DEVICE_ID, (unsigned int)event.pulse,
    (unsigned long long)event.sequence, event.timestamp);
  if (len < 0 || len >= (int)sizeof(body)) {
    Serial.println("ERROR: JSON BODY TOO LONG");
    http.end();
    return SEND_RETRY;
  }

  Serial.printf("HTTP POST start: pulse=%u sequence=%llu\n",
    (unsigned int)event.pulse, (unsigned long long)event.sequence);
  int code = http.POST((uint8_t*)body, (size_t)len);
  Serial.printf("API HTTP %d\n", code);
  if (code < 0) {
    Serial.print("HTTP transport error: ");
    Serial.println(http.errorToString(code));
  }

  String response;
  if (code > 0) {
    response = http.getString();
    // Keep success responses visible for diagnosis (no bearer token exposed).
    Serial.print("API response: ");
    Serial.println(response.substring(0, 300));
  }
  http.end();
  if (responseOut) *responseOut = response;

  if (code == 200 || code == 201) {
    uint32_t tick = millis();
    lastApiSuccessMs = tick ? tick : 1;
    applyMeterConstantFromResponse(response);
    uint32_t cloudTotal = 0;
    if (parseJsonUnsigned(response, "totalPulses", cloudTotal)) {
      cloudPulseCount = cloudTotal;
      cloudTotalKnown = true;
    }

    if (event.pulse == 1) {
      // On this backend, a *new* event is HTTP 201 / duplicate:false.
      // HTTP 200 / duplicate:true is a historical sequence collision OR a
      // legitimate retry. Only acknowledge a retry when its timestamp matches
      // the already-stored event, as returned by the updated backend.
      if (code == 201 && response.indexOf("\"duplicate\":false") >= 0) return SEND_OK;
      if (code == 200 && response.indexOf("\"duplicate\":true") >= 0) {
        String existingTimestamp;
        if (extractJsonString(response, "existingTimestamp", existingTimestamp) &&
            existingTimestamp == String(event.timestamp)) {
          Serial.printf("CONFIRMED IDEMPOTENT RETRY: seq=%llu\n",
            (unsigned long long)event.sequence);
          return SEND_OK;
        }
        Serial.printf("SEQUENCE COLLISION: seq=%llu; not acknowledged\n",
          (unsigned long long)event.sequence);
        return SEND_SEQUENCE_CONFLICT;
      }
      Serial.println("UNEXPECTED PULSE ACK RESPONSE: event retained");
      return SEND_RETRY;
    }
    return SEND_OK;
  }
  if (code == 400) return SEND_BAD_EVENT;
  if (code == 401 || code == 403) return SEND_AUTH_ERROR;
  return SEND_RETRY;
}

// The backend needs only an immediate heartbeat to verify device reachability.
// If meterConstant is not returned, keep retrying config, BUT do not block
// offline pulse replay: the absence of config must not hold all uploads hostage.
bool syncDeviceConfigViaHeartbeat() {
  NetworkEvent hb{};
  fillHeartbeat(hb);
  Serial.println("IMMEDIATE CONFIG HEARTBEAT -> RENDER");
  String response;
  SendResult result = postEvent(hb, &response);
  if (result != SEND_OK) return false;
  if (!verifyServerSequenceHead(response)) return false;
  if (!meterConstantReady) {
    Serial.println("CONFIG HEARTBEAT OK; meterConstant not yet returned");
    return false;
  }
  Serial.println("CONFIG HEARTBEAT SUCCESS; BACKEND REACHABLE");
  return true;
}

bool parseJsonUnsigned(const String& body, const char* key, uint32_t& value) {
  String token = String("\"") + key + "\"";
  int pos = body.indexOf(token);
  if (pos < 0) return false;
  pos = body.indexOf(':', pos + token.length());
  if (pos < 0) return false;
  ++pos;
  while (pos < (int)body.length() && (body[pos] == ' ' || body[pos] == '\t')) ++pos;
  int end = pos;
  while (end < (int)body.length() && body[end] >= '0' && body[end] <= '9') ++end;
  if (end == pos) return false;
  unsigned long long parsed = strtoull(body.substring(pos, end).c_str(), nullptr, 10);
  if (parsed > UINT32_MAX) return false;
  value = (uint32_t)parsed;
  return true;
}

// The backend must send its true *lastSequence* in the heartbeat. Never
// infer a sequence head from totalPulses: counts and sequences can diverge.
bool parseJsonSequence(const String& body, uint64_t& value) {
  String token = "\"lastSequence\"";
  int pos = body.indexOf(token);
  if (pos < 0) return false;
  pos = body.indexOf(':', pos + token.length());
  if (pos < 0) return false;
  ++pos;
  while (pos < (int)body.length() && (body[pos] == ' ' || body[pos] == '\t')) ++pos;
  if (body.substring(pos, pos + 4) == "null") { value = 0; return true; }
  int end = pos;
  while (end < (int)body.length() && body[end] >= '0' && body[end] <= '9') ++end;
  if (end == pos) return false;
  unsigned long long parsed = strtoull(body.substring(pos, end).c_str(), nullptr, 10);
  if (parsed > 9007199254740991ULL) return false;
  value = (uint64_t)parsed;
  return true;
}

bool verifyServerSequenceHead(const String& heartbeat) {
  uint64_t serverSeq = 0;
  uint32_t serverTotal = 0;
  if (!parseJsonSequence(heartbeat, serverSeq) ||
      !parseJsonUnsigned(heartbeat, "totalPulses", serverTotal)) {
    Serial.println("SEQ GUARD: backend missing lastSequence / totalPulses; update backend FIRST");
    sequenceReady = false;
    return false;
  }

  const uint64_t localSeq = getCurrentSequence();
  const uint64_t ack = getLastSyncedSequence();
  Serial.printf("SEQ GUARD: serverSeq=%llu serverTotal=%lu localSeq=%llu ack=%llu localTotal=%lu\n",
      (unsigned long long)serverSeq, (unsigned long)serverTotal,
      (unsigned long long)localSeq, (unsigned long long)ack,
      (unsigned long)getLocalPulseCount());

  if (serverSeq < ack || (serverSeq > localSeq && ack < localSeq)) {
    // Possible backend rollback or outbox collisions. No safe automatic remap.
    sequenceReady = false;
    sequenceConflict = true;
    Serial.println("SEQ GUARD HALT: server/local pending history conflicts; no reset performed");
    return false;
  }

  if (serverSeq > localSeq) {
    // All local sequences were previously acknowledged. Do not replay them.
    // Move the *NEXT* event identity above the actual server sequence head.
    portENTER_CRITICAL(&sequenceMux);
    currentSequence = serverSeq;
    lastSyncedSequence = serverSeq;
    portEXIT_CRITICAL(&sequenceMux);
    preferences.putULong64("sequence", serverSeq);
    preferences.putULong64("lastSynced", serverSeq);
    Serial.println("SEQ GUARD: bumped stale local sequence above server history");
  }

  if (!localTotalInitialized) {
    if (getLastSyncedSequence() < getCurrentSequence()) {
      sequenceReady = false;
      sequenceConflict = true;
      Serial.println("SEQ GUARD HALT: pending events and no local total baseline");
      return false;
    }
    portENTER_CRITICAL(&meterMux);
    localPulseCount = serverTotal;
    if (meterConstantReady) energyKWh = (float)serverTotal / (float)meterConstant;
    portEXIT_CRITICAL(&meterMux);
    localTotalInitialized = true;
    preferences.putULong("localPulses", serverTotal);
    Serial.printf("SEQ GUARD: local total bootstrapped=%lu\n", (unsigned long)serverTotal);
  } else if (getLastSyncedSequence() == getCurrentSequence() &&
             getLocalPulseCount() < serverTotal) {
    // No pending unacknowledged local pulses: safe to advance stale local count.
    portENTER_CRITICAL(&meterMux);
    localPulseCount = serverTotal;
    if (meterConstantReady) energyKWh = (float)serverTotal / (float)meterConstant;
    portEXIT_CRITICAL(&meterMux);
    preferences.putULong("localPulses", serverTotal);
  }

  if (getLastSyncedSequence() == getCurrentSequence() &&
      getLocalPulseCount() > serverTotal) {
    Serial.printf("UNRECONCILED LOCAL PULSES=%lu: history NOT uploaded automatically\n",
      (unsigned long)(getLocalPulseCount() - serverTotal));
  }

  preferences.putBool("seqV2Ready", true);
  sequenceConflict = false;
  sequenceReady = true;
  return true;
}

bool applyMeterConstantFromResponse(const String& response) {
  uint32_t serverK = 0;
  if (!parseJsonUnsigned(response, "meterConstant", serverK) ||
      serverK < 1 || serverK > 100000) return false;

  if (getMeterConstant() == serverK) return true;
  portENTER_CRITICAL(&meterMux);
  meterConstant = serverK;
  meterConstantReady = true;
  energyKWh = (float)localPulseCount / (float)meterConstant;
  powerKW = 0.0f;
  portEXIT_CRITICAL(&meterMux);
  preferences.putUInt("meterConst", serverK);
  Serial.printf("METER CONSTANT UPDATED: %lu imp/kWh\n", (unsigned long)serverK);
  return true;
}

// ---------- Best-effort remote optical telemetry (NO consumption events) ----------
bool postRemoteOpticalDiagnostic(const TeptDiagnostic& d) {
  if (WiFi.status() != WL_CONNECTED) return false;
  String endpoint(API_URL);
  const int slash = endpoint.lastIndexOf('/');
  if (!endpoint.startsWith("https://") || slash < 0) return false;
  endpoint = endpoint.substring(0, slash) + "/diagnostics";

  char body[700];
  const int n = snprintf(body, sizeof(body),
    "{\"deviceId\":\"%s\",\"diagnosticOnly\":%s,"
    "\"minimum\":%d,\"maximum\":%d,\"baseline\":%d,"
    "\"peakDelta\":%d,\"onDelta\":%d,\"offDelta\":%d,"
    "\"samples\":%lu,\"candidates\":%lu,\"detected\":%lu,"
    "\"shortRejected\":%lu,\"longRejected\":%lu,"
    "\"saturatedSamples\":%lu,\"queueDrops\":%lu,\"armed\":%s}",
    DEVICE_ID, TEPT_DIAGNOSTIC_ONLY ? "true" : "false",
    d.minimum, d.maximum, d.baseline, d.peakDelta, d.onDelta, d.offDelta,
    (unsigned long)d.samples, (unsigned long)d.candidates,
    (unsigned long)d.accepted, (unsigned long)d.shortRejected,
    (unsigned long)d.longRejected, (unsigned long)d.saturatedSamples,
    (unsigned long)d.queueDrops, d.armed ? "true" : "false");
  if (n < 0 || n >= (int)sizeof(body)) return false;
  WiFiClientSecure client;
#ifdef ECG_ROOT_CA
  client.setCACert(ECG_ROOT_CA);
#else
  client.setInsecure(); // Prototype only; configure ECG_ROOT_CA before deployment.
#endif
  HTTPClient http;
  http.setConnectTimeout(TEPT_TELEMETRY_CONNECT_TIMEOUT_MS);
  http.setTimeout(TEPT_TELEMETRY_RESPONSE_TIMEOUT_MS);
  if (!http.begin(client, endpoint)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_SECRET);
  const int code = http.POST((uint8_t*)body, (size_t)n);
  http.end();
  if (code != 200) {
    Serial.printf("REMOTE TEPT POST FAILED: HTTP %d (latest window dropped)\n", code);
    return false;
  }
  Serial.printf("REMOTE TEPT SENT: max=%d detected=%lu short=%lu\n",
                d.maximum, (unsigned long)d.accepted, (unsigned long)d.shortRejected);
  return true;
}

// Local-network OTA uploads are deliberately password-gated. An .ino file
// cannot be pulled/installed from GitHub without a compiled firmware image.
// Define a strong OTA_PASSWORD in your private secrets.h and flash via USB ONCE.
void setupLocalOtaIfConnected() {
#if defined(OTA_PASSWORD)
  if (otaStarted || WiFi.status() != WL_CONNECTED || provisioningMode) return;
  if (strlen(OTA_PASSWORD) < 16) {
    static bool warned = false;
    if (!warned) {
      Serial.println("OTA DISABLED: OTA_PASSWORD must be at least 16 characters");
      warned = true;
    }
    return;
  }
  ArduinoOTA.setHostname(DEVICE_ID);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {
    Serial.println("OTA STARTED: avoid power loss; NVS and LittleFS are retained");
  });
  ArduinoOTA.onEnd([]() { Serial.println("OTA COMPLETE: restarting"); });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA ERROR: %u\n", (unsigned int)error);
  });
  ArduinoOTA.begin();
  otaStarted = true;
  Serial.printf("LOCAL OTA READY: %s (%s)\n", DEVICE_ID, WiFi.localIP().toString().c_str());
#else
  static bool warned = false;
  if (!warned && WiFi.status() == WL_CONNECTED) {
    Serial.println("LOCAL OTA DISABLED: define strong OTA_PASSWORD in secrets.h");
    warned = true;
  }
#endif
}

// ---------- Network worker ----------
void networkTask(void* parameter) {
  bool wasConnected = false;
  bool configSyncPending = true;

  while (true) {
    if (provisioningMode) {
      setupServer.handleClient();
      if (provisionRestartAt > 0 &&
          (long)(millis() - provisionRestartAt) >= 0) {
        Serial.println("RESTARTING WITH SAVED WIFI");
        delay(100);
        ESP.restart();
      }
    }

    bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !wasConnected) {
      wasConnected = true;
      wifiFailureSince = 0;
      configSyncPending = true;
      sequenceReady = false;  // Reconcile remote head before continuing uploads.
      lastConfigAttempt = 0;
      lastNtpPoll = 0;
      Serial.println("WIFI CONNECTED");
      Serial.print("IP: "); Serial.println(WiFi.localIP());
      if (provisioningMode) stopProvisioningMode();
      // Non-blocking SNTP; avoids waiting 8 seconds before first API POST.
      configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
    }

    if (!connected) {
      wasConnected = false;
      if (!hasSavedWifiCredentials()) {
        if (!provisioningMode) startProvisioningMode();
      } else {
        unsigned long nowMs = millis();
        if (!wifiFailureSince) wifiFailureSince = nowMs;
        if (nowMs - lastWiFiAttempt >= WIFI_RETRY_MS) {
          lastWiFiAttempt = nowMs;
          Serial.println("WIFI RECONNECTING");
          WiFi.begin(savedWifiSsid.c_str(), savedWifiPassword.c_str());
        }
        if (!provisioningMode && nowMs - wifiFailureSince >= WIFI_SETUP_FALLBACK_MS) {
          Serial.println("WIFI UNAVAILABLE: ENTERING SETUP AP MODE");
          startProvisioningMode();
        }
      }
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    pollNtpOnNetworkCore();

    // Config heartbeat happens immediately after association; failures retry.
    // Unlike original firmware, failures do not prevent pulse replay.
    if (configSyncPending &&
        (lastConfigAttempt == 0 || millis() - lastConfigAttempt >= CONFIG_RETRY_MS)) {
      lastConfigAttempt = millis();
      if (syncDeviceConfigViaHeartbeat()) configSyncPending = false;
    }

    if (!sequenceReady) {
      // Do not replay old events or use sequence IDs until server check passes.
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    bool handledFlashEvent = false;
    if (flashReady) {
      NetworkEvent event{};
      if (loadNextFlashOutboxEvent(event)) {
        handledFlashEvent = true;
        Serial.printf("FLASH REPLAY sequence=%llu\n", (unsigned long long)event.sequence);
        SendResult result = postEvent(event);
        if (result == SEND_OK) {
          markSequenceSynced(event.sequence);
          compactFlashOutboxIfSynced();
        } else if (result == SEND_SEQUENCE_CONFLICT) {
          sequenceReady = false;
          sequenceConflict = true;
          Serial.println("SEQ GUARD HALT: mismatched duplicate event; flash event retained");
        } else if (result == SEND_BAD_EVENT) {
          // Preserve rejected event separately, instead of simply discarding it.
          if (appendFlashDeadLetter(event, "HTTP_400")) {
            Serial.println("REJECTED PULSE SAVED TO DEAD-LETTER FILE");
            markSequenceSynced(event.sequence);
            compactFlashOutboxIfSynced();
          } else {
            Serial.println("CRITICAL: DEAD-LETTER WRITE FAILED; ORIGINAL EVENT KEPT");
          }
        } else if (result == SEND_AUTH_ERROR) {
          Serial.println("AUTH ERROR 401/403; WILL RETRY IN 30 SECONDS");
          vTaskDelay(pdMS_TO_TICKS(30000));
        } else {
          Serial.println("FLASH EVENT KEPT; POST FAILED; RETRY IN 2 SECONDS");
          vTaskDelay(pdMS_TO_TICKS(2000));
        }
      }
    }
    if (handledFlashEvent) { vTaskDelay(pdMS_TO_TICKS(30)); continue; }

    // Events using RAM fallback and scheduled heartbeats.
    if (networkQueue && uxQueueMessagesWaiting(networkQueue) > 0) {
      NetworkEvent event{};
      if (xQueuePeek(networkQueue, &event, pdMS_TO_TICKS(50)) == pdTRUE) {
        SendResult result = postEvent(event);
        if (result == SEND_OK) {
          if (event.pulse == 1) markSequenceSynced(event.sequence);
          xQueueReceive(networkQueue, &event, 0);
        } else if (result == SEND_SEQUENCE_CONFLICT) {
          sequenceReady = false;
          sequenceConflict = true;
          Serial.println("SEQ GUARD HALT: mismatched duplicate event; RAM event retained");
        } else if (result == SEND_BAD_EVENT) {
          if (event.pulse == 0) {
            // Heartbeats are ephemeral. A rejected heartbeat must not block
            // future physical pulse events in the RAM queue.
            Serial.println("HTTP 400 FOR HEARTBEAT; DISCARDING EPHEMERAL HEARTBEAT");
            xQueueReceive(networkQueue, &event, 0);
          } else {
            // Keep rejected physical pulses instead of silently deleting them.
            Serial.println("HTTP 400 FOR RAM PULSE; RETAINED (CHECK TIMESTAMP/PAYLOAD)");
            vTaskDelay(pdMS_TO_TICKS(10000));
          }
        } else if (result == SEND_AUTH_ERROR) {
          Serial.println("AUTH ERROR; RAM EVENT RETAINED");
          vTaskDelay(pdMS_TO_TICKS(30000));
        } else {
          Serial.println("RAM EVENT RETAINED; RETRY IN 2 SECONDS");
          vTaskDelay(pdMS_TO_TICKS(2000));
        }
      }
    }

    // Best-effort diagnostic upload only when the pulse outbox/RAM queue is idle.
    // NEVER block opticalADC task, never increment meter totals, never retry
    // stale diagnostic intervals after a network failure.
    if (ENABLE_REMOTE_TEPT_LOGS && remoteDiagnosticQueue &&
        (!networkQueue || uxQueueMessagesWaiting(networkQueue) == 0) &&
        getCurrentSequence() <= getLastSyncedSequence()) {
      NetworkEvent pending{};
      bool unsentFlash = flashReady && loadNextFlashOutboxEvent(pending);
      if (!unsentFlash) {
        TeptDiagnostic stats{};
        if (xQueueReceive(remoteDiagnosticQueue, &stats, 0) == pdTRUE)
          postRemoteOpticalDiagnostic(stats);
      }
    }

    // Pulse-total + sequence are bootstrapped atomically from heartbeat
    // inside verifyServerSequenceHead; never bootstrap just one of them.
    vTaskDelay(pdMS_TO_TICKS(40));
  }
}

// ---------- LittleFS: flash-backed append-only outbox ----------
bool initFlashStorage() {
  bool initializedEarlier = preferences.getBool("fsInitialized", false);
  if (LittleFS.begin(false)) {
    if (!initializedEarlier) preferences.putBool("fsInitialized", true);
    return true;
  }
  // Never auto-format LittleFS in a diagnostic firmware update. Formatting
  // could permanently erase queued pulse events or historic outbox evidence.
  Serial.println("LITTLEFS MOUNT FAILED: NO FORMAT; OUTBOX PRESERVED");
  return false;
}

void ensureFlashFile(const char* path, const char* header) {
  if (!flashReady || LittleFS.exists(path)) return;
  File f = LittleFS.open(path, FILE_WRITE);
  if (!f) { flashReady = false; Serial.printf("FAILED TO CREATE %s\n", path); return; }
  f.println(header);
  f.close();
}

bool appendFlashOutboxEvent(const NetworkEvent& event) {
  if (!flashReady || !flashMutex ||
      xSemaphoreTake(flashMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  File f = LittleFS.open(OUTBOX_PATH, FILE_APPEND);
  if (!f) {
    flashReady = false;
    xSemaphoreGive(flashMutex);
    Serial.println("FLASH OUTBOX OPEN FAILED");
    return false;
  }
  // One CSV row; check byte count to catch full partition / write failures.
  char row[128];
  int n = snprintf(row, sizeof(row), "%llu,%u,%s,%lu\n",
    (unsigned long long)event.sequence, (unsigned int)event.pulse,
    event.timestamp, (unsigned long)event.localTotal);
  bool ok = n > 0 && n < (int)sizeof(row) &&
            f.write((const uint8_t*)row, (size_t)n) == (size_t)n;
  f.close();
  xSemaphoreGive(flashMutex);
  if (!ok) Serial.println("FLASH OUTBOX SHORT/FAILED WRITE");
  return ok;
}

bool parseFlashCsvLine(const String& line, NetworkEvent& event) {
  int a = line.indexOf(',');
  int b = line.indexOf(',', a + 1);
  int c = line.indexOf(',', b + 1);
  if (a <= 0 || b <= a || c <= b) return false;
  event.sequence = strtoull(line.substring(0, a).c_str(), nullptr, 10);
  event.pulse = line.substring(a + 1, b).toInt() == 1 ? 1 : 0;
  String stamp = line.substring(b + 1, c);
  if (stamp.length() >= sizeof(event.timestamp)) return false;
  snprintf(event.timestamp, sizeof(event.timestamp), "%s", stamp.c_str());
  event.localTotal = strtoul(line.substring(c + 1).c_str(), nullptr, 10);
  return true;
}

bool loadNextFlashOutboxEvent(NetworkEvent& event) {
  if (!flashReady || !flashMutex ||
      xSemaphoreTake(flashMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  File f = LittleFS.open(OUTBOX_PATH, FILE_READ);
  if (!f) {
    flashReady = false;
    xSemaphoreGive(flashMutex);
    Serial.println("FLASH OUTBOX READ FAILED");
    return false;
  }
  uint64_t synced = getLastSyncedSequence();
  bool found = false;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("sequence,")) continue;
    NetworkEvent candidate{};
    if (!parseFlashCsvLine(line, candidate)) continue;
    if (candidate.sequence > synced) { event = candidate; found = true; break; }
  }
  f.close();
  xSemaphoreGive(flashMutex);
  return found;
}

bool appendFlashDeadLetter(const NetworkEvent& event, const char* reason) {
  if (!flashReady || !flashMutex ||
      xSemaphoreTake(flashMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
  File f = LittleFS.open(DEAD_PATH, FILE_APPEND);
  if (!f) { xSemaphoreGive(flashMutex); return false; }
  char row[160];
  int n = snprintf(row, sizeof(row), "%llu,%u,%s,%lu,%s\n",
    (unsigned long long)event.sequence, (unsigned int)event.pulse,
    event.timestamp, (unsigned long)event.localTotal, reason);
  bool ok = n > 0 && n < (int)sizeof(row) &&
            f.write((const uint8_t*)row, (size_t)n) == (size_t)n;
  f.close();
  xSemaphoreGive(flashMutex);
  return ok;
}

void recoverPersistentStateFromFlash() {
  if (!flashReady || !flashMutex ||
      xSemaphoreTake(flashMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return;
  File f = LittleFS.open(OUTBOX_PATH, FILE_READ);
  if (!f) { xSemaphoreGive(flashMutex); return; }
  uint64_t maxSeq = 0;
  uint32_t maxTotal = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("sequence,")) continue;
    NetworkEvent ev{};
    if (!parseFlashCsvLine(line, ev)) continue;
    if (ev.sequence > maxSeq) maxSeq = ev.sequence;
    if (ev.localTotal > maxTotal) maxTotal = ev.localTotal;
  }
  f.close();
  xSemaphoreGive(flashMutex);

  if (maxSeq > getCurrentSequence()) {
    portENTER_CRITICAL(&sequenceMux);
    currentSequence = maxSeq;
    portEXIT_CRITICAL(&sequenceMux);
    preferences.putULong64("sequence", maxSeq);
    Serial.printf("FLASH RECOVERED SEQUENCE=%llu\n", (unsigned long long)maxSeq);
  }
  if (localTotalInitialized && maxTotal > getLocalPulseCount()) {
    portENTER_CRITICAL(&meterMux);
    localPulseCount = maxTotal;
    if (meterConstantReady) energyKWh = (float)maxTotal / (float)meterConstant;
    portEXIT_CRITICAL(&meterMux);
    preferences.putULong("localPulses", maxTotal);
  }
}

void compactFlashOutboxIfSynced() {
  if (!flashReady || !flashMutex ||
      getLastSyncedSequence() < getCurrentSequence() ||
      xSemaphoreTake(flashMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return;
  File f = LittleFS.open(OUTBOX_PATH, FILE_READ);
  if (!f) { xSemaphoreGive(flashMutex); return; }
  size_t currentSize = f.size();
  f.close();
  if (currentSize >= OUTBOX_COMPACT_BYTES) {
    File fresh = LittleFS.open(OUTBOX_PATH, FILE_WRITE);
    if (fresh) {
      fresh.println("sequence,pulse,timestamp,localTotal");
      fresh.close();
      Serial.println("FLASH OUTBOX COMPACTED AFTER ACKS");
    }
  }
  xSemaphoreGive(flashMutex);
}

void markSequenceSynced(uint64_t sequence) {
  bool changed = false;
  portENTER_CRITICAL(&sequenceMux);
  if (sequence > lastSyncedSequence) {
    lastSyncedSequence = sequence;
    changed = true;
  }
  portEXIT_CRITICAL(&sequenceMux);
  if (changed) {
    preferences.putULong64("lastSynced", sequence);
    Serial.printf("ACKED THROUGH SEQUENCE %llu\n", (unsigned long long)sequence);
  }
}

uint64_t getCurrentSequence() {
  uint64_t value;
  portENTER_CRITICAL(&sequenceMux); value = currentSequence; portEXIT_CRITICAL(&sequenceMux);
  return value;
}
uint64_t getLastSyncedSequence() {
  uint64_t value;
  portENTER_CRITICAL(&sequenceMux); value = lastSyncedSequence; portEXIT_CRITICAL(&sequenceMux);
  return value;
}
uint32_t getLocalPulseCount() {
  uint32_t value;
  portENTER_CRITICAL(&meterMux); value = localPulseCount; portEXIT_CRITICAL(&meterMux);
  return value;
}
uint32_t getMeterConstant() {
  uint32_t value;
  portENTER_CRITICAL(&meterMux);
  value = meterConstantReady ? meterConstant : 0;
  portEXIT_CRITICAL(&meterMux);
  return value;
}

// ---------- Local Wi-Fi provisioning ----------
bool hasSavedWifiCredentials() { return savedWifiSsid.length() > 0; }

void startSavedWifiConnection() {
  if (!hasSavedWifiCredentials()) { startProvisioningMode(); return; }
  WiFi.mode(provisioningMode ? WIFI_AP_STA : WIFI_STA);
  Serial.print("CONNECTING TO SAVED WIFI: "); Serial.println(savedWifiSsid);
  WiFi.begin(savedWifiSsid.c_str(), savedWifiPassword.c_str());
  lastWiFiAttempt = millis();
  wifiFailureSince = millis();
}

void startProvisioningMode() {
  if (provisioningMode) return;
  WiFi.mode(hasSavedWifiCredentials() ? WIFI_AP_STA : WIFI_AP);
  if (!WiFi.softAP(setupApSsid.c_str())) {
    Serial.println("SETUP AP START FAILED");
    return;
  }
  setupServer.begin();
  provisioningMode = true;
  provisionRestartAt = 0;
  Serial.print("SETUP AP: "); Serial.println(setupApSsid);
  Serial.print("SETUP PAGE IP: "); Serial.println(WiFi.softAPIP());
}

void stopProvisioningMode() {
  if (!provisioningMode) return;
  setupServer.stop();
  WiFi.softAPdisconnect(true);
  provisioningMode = false;
  provisionRestartAt = 0;
  WiFi.mode(WIFI_STA);
  Serial.println("SETUP MODE CLOSED");
}

bool extractJsonString(const String& body, const char* key, String& value) {
  String token = String("\"") + key + "\"";
  int pos = body.indexOf(token);
  if (pos < 0) return false;
  pos = body.indexOf(':', pos + token.length());
  if (pos < 0) return false;
  ++pos;
  while (pos < (int)body.length() &&
         (body[pos] == ' ' || body[pos] == '\t' || body[pos] == '\n' || body[pos] == '\r')) ++pos;
  if (pos >= (int)body.length() || body[pos] != '"') return false;
  ++pos;
  String parsed;
  while (pos < (int)body.length()) {
    char ch = body[pos++];
    if (ch == '"') { value = parsed; return true; }
    if (ch == '\\') {
      if (pos >= (int)body.length()) return false;
      char escaped = body[pos++];
      switch (escaped) {
        case '"': case '\\': case '/': parsed += escaped; break;
        case 'b': parsed += '\b'; break;
        case 'f': parsed += '\f'; break;
        case 'n': parsed += '\n'; break;
        case 'r': parsed += '\r'; break;
        case 't': parsed += '\t'; break;
        default: return false;  // No silent decoding of unknown escapes.
      }
    } else parsed += ch;
  }
  return false;
}

void configureProvisioningServer() {
  setupServer.on("/", HTTP_GET, []() {
    setupServer.send(200, "text/plain", "ECG Smart Power setup device");
  });
  setupServer.on("/status", HTTP_GET, []() {
    setupServer.sendHeader("Cache-Control", "no-store");
    setupServer.send(200, "application/json",
      String("{\"deviceId\":\"") + DEVICE_ID +
      "\",\"setupMode\":" + (provisioningMode ? "true" : "false") + "}");
  });
  setupServer.on("/provision", HTTP_POST, []() {
    String ssid, password;
    String body = setupServer.arg("plain");
    if (!extractJsonString(body, "ssid", ssid) ||
        !extractJsonString(body, "password", password)) {
      setupServer.send(400, "application/json",
        "{\"ok\":false,\"error\":\"Provide JSON ssid and password strings\"}");
      return;
    }
    ssid.trim();
    if (ssid.length() < 1 || ssid.length() > 32 || password.length() > 63) {
      setupServer.send(400, "application/json",
        "{\"ok\":false,\"error\":\"Invalid SSID/password length\"}");
      return;
    }
    if (!preferences.putString("wifiSsid", ssid)) {
      setupServer.send(500, "application/json",
        "{\"ok\":false,\"error\":\"Wi-Fi settings not saved\"}");
      return;
    }
    preferences.putString("wifiPassword", password);
    savedWifiSsid = ssid;
    savedWifiPassword = password;
    Serial.print("WIFI SETTINGS UPDATED FOR SSID: "); Serial.println(savedWifiSsid);
    setupServer.sendHeader("Cache-Control", "no-store");
    setupServer.send(200, "application/json",
      String("{\"ok\":true,\"deviceId\":\"") + DEVICE_ID +
      "\",\"restarting\":true}");
    provisionRestartAt = millis() + PROVISION_RESTART_DELAY_MS;
  });
  setupServer.onNotFound([]() {
    setupServer.send(404, "application/json", "{\"ok\":false,\"error\":\"Not found\"}");
  });
}