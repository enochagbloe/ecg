# ECG ESP32 remote optical diagnostics (USB uploads only)

This Arduino sketch targets the **classic ESP32 DevKit**, with a TEPT4400 phototransistor on GPIO34 (10 kΩ pull-down to GND), DS3231 and SH1106 OLED. It keeps the existing Sequence Guard, LittleFS outbox, NVS pulse totals, Render heartbeat and Wi-Fi connection.

**No OTA firmware-update code is included in this version.** Firmware changes are uploaded with USB.

## Installation

1. Back up your existing `ecg_meter_cloud.ino` and preserve your local NVS and LittleFS pulse records. Do **not** select *Erase All Flash* or change your partition scheme.
2. Copy `firmware/ecg_meter_cloud/ecg_meter_cloud.ino` into your existing Arduino sketch folder.
3. Leave your **private `secrets.h`** beside the .ino file, containing your existing `API_URL`, `DEVICE_ID`, and working `DEVICE_SECRET`. Do not commit `secrets.h` to public GitHub. No `OTA_PASSWORD` is required.
4. Upload once by USB using the same Arduino board configuration as the working prototype.
5. Open Serial Monitor at 115200 baud. Look for `SEQ GUARD` and `REMOTE TEPT SENT`, or `REMOTE TEPT POST FAILED: HTTP ...`.

## Remote diagnostics

By default, `TEPT_DIAGNOSTIC_ONLY = true`: optical test flashes **do not** create cloud consumption events or increase the saved local pulse total.

Every ~5 seconds, a diagnostic summary is posted over Wi-Fi to `POST /api/v1/device/diagnostics` with the device's existing bearer-token authentication. The backend separately broadcasts `opticalDiagnostic` to authenticated dashboard viewers, and shows a history of up to **60 reports per device**. This history is kept in server memory and will reset on Render restart/redeploy; the meter's PostgreSQL pulse history remains unaffected.

To view the logs on a phone or computer, open the existing ECG dashboard. The **Optical sensor diagnostics** section displays ADC range, ambient baseline, threshold, candidates, accepted, short/long rejected and recent reports. The backend changes must be deployed to Render before the ESP32 can upload diagnostics.

For safe testing, use the TEPT4400 in its opaque non-invasive optical shroud over the meter LED with permission, and compare visible meter blinks against reports. If `maximum=0`, check sensor power, polarity, ADC pin and alignment; if `maximum` rises but `detected=0`, investigate thresholds and rejected pulse-duration statistics. The sensor cannot identify the light source by itself.

The remote endpoint is best-effort: it prioritizes electricity pulse outbox delivery over diagnostic messages, discards stale diagnostic windows if Wi-Fi is down, and never increments pulse totals.

## What this version does NOT provide

- Wi-Fi or GitHub-to-ESP32 firmware updating (OTA).
- Guaranteed capture of asynchronous 1 ms meter flashes; full meter-side validation is pending.
- Production-grade TLS verification without a trusted `ECG_ROOT_CA` configured in `secrets.h`. The prototype uses `setInsecure()` otherwise.

**Build status:** Source has not been compiled or hardware-tested in this environment. Validate with Arduino IDE before relying on it for meter measurements.
