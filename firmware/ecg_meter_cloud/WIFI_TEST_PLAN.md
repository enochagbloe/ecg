# Five-network Wi-Fi validation

The native tests execute the SAME C-compatible profile codec and state machine
included by the ESP32 adapter. They simulate scan results, driver state and time;
they are not claims of physical radio, power-failure or HTTPS testing.

## Automated checks

From the repository root (GCC/Clang on Linux/macOS):

```sh
cc -std=c99 -Wall -Wextra -Werror firmware/ecg_meter_cloud/tests/wifi_policy_test.c -o /tmp/ecg-wifi-tests
/tmp/ecg-wifi-tests
node --test firmware/ecg_meter_cloud/tests/onboarding.test.mjs
python3 firmware/ecg_meter_cloud/tests/check_preservation.py BASE_COMMIT
```

`BASE_COMMIT` is the pre-change commit (`4d4f5eeb1d5e4f52071fe832e89eab1416e39f19` for this change).
CI runs the portable policy/onboarding tests and a real ESP32 compile. Run the
preservation comparison manually against the pre-change SHA before merging.
The preservation check intentionally compares against the old single-network version;
it is a migration-specific guard rather than a permanent generic firmware test.

Policy cases cover home/office/hotspot selection, priorities, credential failures,
two controlled reconnects then alternatives, stable connections, setup fallback,
returning networks, newly saved profiles, adding profiles while connected, timeout
and cancellation handling, millis rollover, five-slot capacity, password retention,
serialized restart snapshots, corrupt snapshots, boundaries, and 20,000 stress ticks.
The browser tests execute the actual inline onboarding script with a minimal DOM
and HTTP fixtures. They cover safe SSID rendering, password omission/open networks,
save errors, removal and Done; the embedded HTTP/NVS adapter still needs bench testing.

## Bench checklist (not performed automatically)

Keep the test source stopped, back up state and record local/cloud totals and the
last sequence. Use the current partition layout; do not erase all flash or upload
a filesystem image. Preserve the repository's existing diagnostic/live setting.

| Scenario | Procedure | Required result |
|---|---|---|
| 1. Home on boot | Save five profiles; make Home the highest available priority; reboot | Home selected, one association, valid backend handshake |
| 2. Office only | Disable Home; enable Office; boot | Office selected without entering new credentials |
| 3. Hotspot only | Disable Home/Office; enable saved 2.4 GHz phone hotspot | Hotspot selected |
| 4. Link disappears | Turn off current AP during connection and during an upload | At most two controlled reconnect attempts, then scan alternatives; no overlapping begin/reconnect errors |
| 5. All unavailable | Disable all saved networks | Setup AP and local page accessible; saved profiles and pulse records retained; periodic rescan |
| 6. Network returns | Restore a saved AP during offline backoff; also restore a higher-priority AP while another is stable | Offline device reconnects after rescan; stable device does not roam |
| 7. Restart/power loss | Save profiles and known pulse records; restart. On a spare device interrupt a profile-save commit | All previously committed credentials and pulse records retained; no mixed SSID/password pairs |
| 8. Upload interrupted | Use a known small pulse count in live mode on a spare device; drop Wi-Fi after the server receives a request but before ACK reaches ESP32 | Same queued sequence/timestamp retried; backend unique (deviceId,sequence) prevents double counting; existing guard confirms duplicate timestamp or retains event |

After each switch check `WIFI CONNECTED`, then the actual config heartbeat result
before `BACKEND CONNECTION RESTORED` / `RESUMING PENDING UPLOADS`. Compare pulse IDs,
not just the last sequence head. No network operation should reset a meter key,
change identity/token, reassign event sequences, format LittleFS or clear a queue.
The existing outbox/sequence implementation is intentionally unchanged by this PR;
this change does not certify recovery of events already lost by older firmware.
