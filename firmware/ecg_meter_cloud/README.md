# ECG ESP32 remote optical diagnostics (USB uploads only)

This Arduino sketch targets the **classic ESP32 DevKit**, with a TEPT4400 phototransistor on GPIO34 (10 kÎ© pull-down to GND), DS3231 and SH1106 OLED. It keeps the existing Sequence Guard, LittleFS outbox, NVS pulse totals, Render heartbeat and Wi-Fi connection.

**No OTA firmware-update code is included in this version.** Firmware changes are uploaded with USB.

## Installation

1. Back up your existing `ecg_meter_cloud.ino` and preserve your local NVS and LittleFS pulse records. Do **not** select *Erase All Flash* or change your partition scheme.
2. Copy **all four source files** into the same Arduino sketch folder: `ecg_meter_cloud.ino`, `MultiWifiManager.h`, `WifiPolicy.h`, and `WifiProfiles.h`.
3. Leave your **private `secrets.h`** beside the .ino file, containing your existing `API_URL`, `DEVICE_ID`, and working `DEVICE_SECRET`. Do not commit `secrets.h` to public GitHub. No `OTA_PASSWORD` is required.
4. Upload once by USB using the same Arduino board configuration as the working prototype.
5. Open Serial Monitor at 115200 baud. Look for `SEQ GUARD` and `REMOTE TEPT SENT`, or `REMOTE TEPT POST FAILED: HTTP ...`.

## Remote diagnostics

By default, `TEPT_DIAGNOSTIC_ONLY = true`: optical test flashes **do not** create cloud consumption events or increase the saved local pulse total.

Every ~5 seconds, a diagnostic summary is posted over Wi-Fi to `POST /api/v1/device/diagnostics` with the device's existing bearer-token authentication. The backend separately broadcasts `opticalDiagnostic` to authenticated dashboard viewers, and shows a history of up to **60 reports per device**. This history is kept in server memory and will reset on Render restart/redeploy; the meter's PostgreSQL pulse history remains unaffected.

To view the logs on a phone or computer, open the existing ECG dashboard. The **Optical sensor diagnostics** section displays ADC range, ambient baseline, threshold, candidates, accepted, short/long rejected and recent reports. The backend changes must be deployed to Render before the ESP32 can upload diagnostics.

For safe testing, use the TEPT4400 in its opaque non-invasive optical shroud over the meter LED with permission, and compare visible meter blinks against reports. If `maximum=0`, check sensor power, polarity, ADC pin and alignment; if `maximum` rises but `detected=0`, investigate thresholds and rejected pulse-duration statistics. The sensor cannot identify the light source by itself.

The remote endpoint is best-effort: it prioritizes electricity pulse outbox delivery over diagnostic messages, discards stale diagnostic windows if Wi-Fi is down, and never increments pulse totals.

## 20 ms controlled flash test

1. First deploy the matching latest ECG backend to Render. The old backend uses strict JSON validation and will reject the six new optional width fields until updated.
2. Use the independent LED-generator sketch in `firmware/arduino_flash_generator/arduino_flash_generator.ino` on a **separate Arduino Uno** (D9 LED pin) or **separate ESP32** (GPIO25 LED pin). Use a 220 Î© LED series resistor.
3. Power the ECG ESP32 from USB with its original private `secrets.h`, ensure `TEPT_DIAGNOSTIC_ONLY = true`, and upload this updated ECG sketch without erasing NVS/LittleFS.
4. Arduino test sends precisely **20 flashes, each 20 ms ON / 800 ms OFF**, after a 5-second LED-OFF baseline. Arduino sends them only once per reset.
5. Compare the ECG dashboard's 5-second sums against the Arduino's 20 generated flashes. Check `widthSamples`, `minWidthUs`, `maxWidthUs`, `averageWidthUs`, `lastWidthUs`, and `maxShortWidthUs`. Values are durations measured **above the adaptive optical threshold**, not necessarily the Arduino's exact LED ON time.
6. If `widthSamples` is zero despite visible light, inspect the sensor orientation and wiring. If most measured widths are under **180 Âµs**, suspect a transient optical/electrical signal, not merely a threshold difference. Keep diagnostic-only mode until repeatable counts are verified.

## What this version does NOT provide

- Wi-Fi or GitHub-to-ESP32 firmware updating (OTA).
- Guaranteed capture of asynchronous 1 ms meter flashes; full meter-side validation is pending.
- Production-grade TLS verification without a trusted `ECG_ROOT_CA` configured in `secrets.h`. The prototype uses `setInsecure()` otherwise.

**Wi-Fi validation:** The shared policy/profile code and onboarding script have automated tests. The complete firmware is compiled against Arduino-ESP32 3.3.12 during validation; physical radio failover, power-loss and upload-interruption testing remain required. See [WIFI_TEST_PLAN.md](WIFI_TEST_PLAN.md).


## Automatic five-network Wi-Fi

The manager stores up to **five** 2.4 GHz network profiles. At boot it scans
asynchronously, chooses the available saved SSID with the lowest priority number
(1 is highest), and tries the next available profile if that attempt fails. Equal
priorities use saved slot order. A working connection never roams merely because
a higher-priority SSID appears. The ESP32 associates to one upstream network at a
time; its setup AP may coexist temporarily for onboarding.

After a link loss it makes **two** controlled attempts at the last working profile,
then scans alternatives. Joins time out after 25 seconds, scans after 15 seconds,
and failed rounds wait 30 seconds before rescanning. Before every attempt the
manager disables STA, confirms the mode no longer includes STA and observes a
settle/retry interval; only then can it start a scan or call `WiFi.begin()`.
Application auto-reconnection is disabled and no `WiFi.reconnect()` path remains.
Some Arduino cores perform one internal first-association retry even with that
setting off; it stays inside the bounded join window and is cancelled by the
station-stop barrier before the manager changes SSIDs.
A dedicated owner task keeps the manager and setup page separate from blocking
backend HTTPS requests. Event callbacks only publish diagnostics under a lock.

If the device remains offline for 30 seconds, it also enables setup at the next
safely stopped station boundary while it continues trying candidates.

When no saved network is reachable, join `<DEVICE_ID>-SETUP` and open the printed
setup IP (normally `192.168.4.1`). Add/update SSIDs and priorities, or remove an
unneeded profile before adding a sixth. The page never fetches or pre-fills stored
passwords. Leave the password blank when editing an existing network to retain
its password; explicitly select open Wi-Fi to save an empty password. A new
protected network needs its password. SSIDs are case-sensitive and limited to
32 UTF-8 bytes; passwords to 63 bytes. Whitespace in SSIDs is preserved.

Saving works **without restarting** the ESP32. Offline changes cancel the current
attempt safely and rescan; online changes apply to the next outage without
switching a stable link. Setup stays available for two minutes after page/save
activity so several profiles can be entered. Once an upstream connection is
working, Done closes setup without disconnecting it. Unattended setup closes
after the activity grace period once connected. If every saved network remains
unreachable, setup stays open and the manager keeps scanning.

### Persistence and migration

Profiles are one versioned, checksummed NVS blob (`profiles`) in the separate
`ecg-wifi` namespace. A save commits the whole blob and reads it back before
publishing new runtime profiles, avoiding separate SSID/password writes. Existing
`ecg-meter` / `wifiSsid` and `wifiPassword` migrate into slot 1 at priority 1 when no
new blob exists. The legacy keys remain untouched. A failed NVS open/write is
reported instead of silently claiming a saved profile; a corrupt or unsupported
blob is retained without automatic erase. Repair of such a blob requires a
separate recovery decision.

The setup API is available while the setup AP is active:

- `GET /networks`: SSIDs, priorities and connection flags only.
- `POST /provision` (also `POST /networks`): `{"ssid":"Office","password":"...","priority":2}`.
  Omit `password` only when preserving an existing profile's password.
- `DELETE /networks`: `{"ssid":"Office"}`.
- `POST /finish`: close setup after a short response grace, only when connected.
- `GET /status`: device ID, setup/connection status, profile count and store health.

A new Wi-Fi connection increments a guarded link generation. The backend worker
checks it even if a complete disconnect/reconnect occurred during a blocked POST,
then runs the existing sequence-head handshake before the next replay. Stored
pulse identities, authentication, ACK handling and outbox files are unchanged.
`BACKEND CONNECTION RESTORED` and `RESUMING PENDING UPLOADS` are printed only after
a successful configuration/sequence handshake, not just after Wi-Fi association.

This is link failover, not an Internet/captive-portal health detector. It does not
leave stable Wi-Fi because Render is slow. Discovery matches SSIDs returned by
the radio scan; hidden SSIDs, enterprise EAP and 5 GHz-only networks are outside
this profile format. Existing finite pulse queues and storage limits still apply;
this Wi-Fi change does not repair pre-existing outbox or sequence history.

This repository's existing diagnostic-only default, optical logic, OLED/RTC,
LittleFS and meter state routines are deliberately retained. The separate live
OLED/storage builds prepared outside this repository are not folded into this
focused change. Back up state and drain RAM-only events before any USB update.

References: [Espressif Wi-Fi API](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html),
[Preferences persistence](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/preferences.html).
