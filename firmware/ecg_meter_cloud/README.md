# ECG ESP32 remote diagnostics + LAN OTA

This Arduino sketch targets the **classic ESP32 DevKit**, with a TEPT4400 on GPIO34 (10 kΩ to GND), DS3231 and SH1106 OLED. It preserves the Sequence Guard, LittleFS outbox and NVS pulse counts.

## Initial setup

1. Back up your existing sketch, NVS and LittleFS/outbox. Avoid **Erase All Flash** and changing partitions.
2. Open `firmware/ecg_meter_cloud/ecg_meter_cloud.ino` in Arduino IDE and retain your **existing private `secrets.h`**, beside it.
3. Add this new value to `secrets.h`:
   ```cpp
   #define OTA_PASSWORD "REPLACE_WITH_YOUR_OWN_STRONG_16_PLUS_CHARACTER_SECRET"
   ```
   Never commit `secrets.h`, `DEVICE_SECRET`, your Wi-Fi password, or a compiled firmware binary containing secrets.
4. Choose the same ESP32 board and partition scheme as the working firmware; you need an **OTA-capable partition layout with two application slots**. First upload must be by USB.
5. Open Serial Monitor (115200) and verify `SEQ GUARD`, `REMOTE TEPT SENT`, and `LOCAL OTA READY` output.
6. Remote optical statistics appear on the existing ECG dashboard **only after** the new backend commits have been deployed to Render.

## Diagnostics

When `TEPT_DIAGNOSTIC_ONLY = true`, accepted optical flashes are **not** written to the pulse history or cloud meter totals. The firmware sends 5-second snapshots of ADC minimum/maximum, ambient baseline, threshold deltas, candidates, accepted, short/long rejected, and saturation to `POST /api/v1/device/diagnostics` with device-token authentication. Backend broadcasts `opticalDiagnostic` and retains **60 snapshots in memory per device** (lost on redeploy). The diagnostics endpoint is independent of the consumption endpoint.

For on-meter testing, monitor the dashboard while the sensor is held stationary in an **opaque optical shroud** over the LED. If `maximum = 0` despite clearly visible LED pulses, verify polarity, supply, ADC voltage and alignment. If candidates increase but accepted does not, analyze rejection counters, pulse width and optical filtering. Avoid enabling LIVE consumption counting until validated.

## Wireless firmware uploads

**Local Wi-Fi OTA is enabled** only if `OTA_PASSWORD` is defined and has at least 16 characters. When the ESP32 is powered and connected to the **same trusted local Wi-Fi** as your computer, Arduino IDE may discover it under **Tools → Port → Network Port**. Select the network port and upload a compiled sketch. If mDNS doesn't discover it, check local IP, firewall, Arduino ESP32 core, and OTA partitions. OTA can interrupt sensor sampling, so use stable power and a quiet test window. Keep backup and recovery access.

### Not yet GitHub-to-device OTA

GitHub stores source files, not deployable firmware. This version **does not auto-download** files from GitHub or Render, and it intentionally does not expose an unsafe unauthenticated browser flashing endpoint. Fully remote OTA requires reproducible binary builds, device-managed secrets (not embedded in a public binary), authenticated firmware manifest, verified image/hash/signature, compatible partitions, recovery/rollback and staged rollout.

This source has **not** been compiled or validated on the physical ESP32 hardware in this environment. Test via Arduino IDE first.
