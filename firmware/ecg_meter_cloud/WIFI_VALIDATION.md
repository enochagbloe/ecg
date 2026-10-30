# Multi-network Wi-Fi validation — 30 October 2026

- Full compile/link passed for classic ESP32 (`esp32:esp32:esp32`) with
  Arduino-ESP32 3.3.12, U8g2 2.36.19, RTClib 2.1.4 and Adafruit BusIO 1.17.4.
- Program: **1,188,720 / 1,310,720 bytes (90%)**.
- Static globals: **53,056 / 327,680 bytes (16%)**. Runtime stacks, scan results,
  Wi-Fi/TLS buffers and other heap allocations are additional. The manager task
  is configured with an 8192-byte stack; runtime memory/stack margins need bench checks.
- **25 native policy/profile scenarios passed**, including a 20,000-tick transition
  stress case, missing networks, failed credentials, cancellation barriers, setup
  fallback/activity, return after outage, profile edits/removal and millis rollover.
  The tests execute the same C-compatible headers included by the firmware.
- **7 onboarding-script tests passed** using the actual embedded JavaScript and
  DOM/HTTP fixtures: safe SSID rendering, password omission/open networks, saving,
  capacity/persistence errors, removing a profile and finishing setup.
- The migration-specific source check passed against commit
  `4d4f5eeb1d5e4f52071fe832e89eab1416e39f19`. Optical sampling, OLED/RTC,
  pulse storage, sequence/ACK protection, backend payload/auth and replay paths
  are unchanged. There is one application `WiFi.begin()` owner, no reconnect()
  or onboarding restart path, and separate profile NVS. No password response or
  Serial log fields were added. The link epoch triggers the existing handshake.
- `git diff --check` passed. CI is supplied for native/browser checks and a
  complete ESP32 compile with dummy credentials only.

**Not executed:** physical home/office/hotspot failover, actual NVS power cuts,
RF/channel behavior, runtime stack measurements, and disconnect-after-server-
commit/lost-ACK testing. Scenario 8 has source-preservation/link-epoch checks,
not an end-to-end hardware result. Follow [WIFI_TEST_PLAN.md](WIFI_TEST_PLAN.md).

No ESP32 was flashed, no saved meter readings were reset, and no backend
records were changed during this implementation. Builds used an isolated
`secrets.h` fixture with a dummy key and `example.invalid`; it is not committed
or included in the downloadable source.

This change targets the repository's existing firmware defaults, including
`TEPT_DIAGNOSTIC_ONLY=true`. It intentionally does not fold in the separate
live-display/storage builds prepared elsewhere in the chat.
