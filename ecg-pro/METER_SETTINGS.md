# Device Settings and meter history

The dashboard now has Overview, Diagnostics and Settings. Settings provides device naming, active/online status, last contact, firmware capability, stored pulse totals, the active IMP/kWh and a dated meter history. It accepts integer constants from 1 through 100000, including 1000, 1005 and 1006. The backend owns the conversion. Firmware continues sending raw immutable pulse identities.

## Meter replacement

1. Stop test flashes or remove the sensor from the LED. Allow pending uploads to finish.
2. Enter the replacement meter reference and the IMP/kWh printed on that meter. Confirm the reset procedure and request the change.
3. Keep the device connected. Wait for Settings to say **Ready for device reset**. Two 30-second heartbeat cycles may be required.
4. Confirm the device shows Synced, then press its physical RESET button. Keep the sensor away from flashes during reset and startup calibration.
5. Wait for Settings to show the replacement configuration as Active before attaching the sensor to the replacement meter.

Reset means restarting the microcontroller. Accounts, ownership, API credentials, raw events, sequence numbers, lifetime pulses and accumulated energy are retained. Never erase NVS or the filesystem. RAM-only captures can be lost during any restart, so stop flashes and drain the queue before resetting.

A pending request can be cancelled. The previous configuration remains active until a valid reset confirmation commits. A reset before the device has acknowledged the pending request cannot activate it. Cancel and request again if the device was reset too early.

## Authenticated boot protocol

`POST /api/v1/device/boot` uses the existing device bearer credential and HTTPS. Example field shapes, with synthetic identifiers only:

```json
{"deviceId":"TEST","bootId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bootHead":20,"resetRequestId":null,"firmwareVersion":"s3-settings-v1"}
```

The firmware captures `bootHead` from the recovered durable journal before starting its storage worker. A cryptographically random 128-bit boot identity remains fixed during that boot. Every heartbeat reports that same identity and boundary. Pulse uploads wait for a matching `ok`, `bootAccepted`, `deviceId` and `bootId` response.

A pending request is issued only to its original boot. The response supplies `armRequestId`, a UUID challenge. Firmware writes it to a separate `grid-settings` NVS namespace and reports it on the next heartbeat. The backend marks the request ready. A later, previously unseen boot must present the same persisted challenge. The backend checks its recovered boundary against the server sequence and previous period, then atomically creates the new period, changes the active constant and clears the pending request. Repeated reports are idempotent. Previously seen old boot identities and changing a boot's boundary are rejected.

The new period starts at `bootHead + 1`. Durable pre-reset records retain their original configuration even if replayed later. Period revision order handles consecutive replacements with zero intervening pulses. No power interval crosses a meter boundary.

The matching S3 firmware integration is prepared in the local GridLoRa_S3_V2.1 project. Older firmware can continue using ingestion after the backend migration, but Settings blocks meter replacement until reset-aware firmware has connected. Updated firmware requires this backend endpoint before pulse uploads resume. A failed control request retains pending pulse records.

## Storage and security

- `MeterPeriod` stores the constant, label, sequence boundary, confirmation identity and effective timestamp. Initial migration imports the existing constant; an original activation date cannot be reconstructed and the UI says so.
- `DeviceSettings` stores a single pending request and current boot capability. `DeviceBoot` retains seen boot identities to reject stale reports.
- `MeterState.energyKWh` accumulates energy at each pulse's original constant. Both single and batch ingestion resolve periods by sequence. Duplicate events leave the ledger unchanged.
- Historical charts, per-pulse details, today's energy and live power use the appropriate period. No cross-meter power interval is synthesized.
- Dashboard endpoints require the existing dashboard session. Customer endpoints require a customer session and device ownership. The old customer PATCH cannot bypass the reset flow to alter IMP/kWh. JSON-only mutations reject cross-site fetches; existing strict session cookies remain in use.
- The legacy reset-test-data path refuses to delete production meter history or populated measurements. This change intentionally protects historical customer consumption.
- No real device credentials, Wi-Fi passwords or database URLs are stored in this change.

## Deployment sequence

This is a coordinated database and firmware rollout. **Quiesce device ingestion while deploying the migration and new backend**. Drain durable queues and stop flashes before powering devices down. Keep old backend instances from accepting events between the energy backfill and the new application taking over. The migration snapshots existing lifetime energy from the current constant; old ingestion code does not maintain the new ledger during a rolling mixed-version overlap. Do not run such an overlap.

1. Preserve a database backup and verify restore procedures. Stop old-version ingestion.
2. Apply the additive migration and deploy this backend. Retain all old pulse and ownership rows.
3. Validate Settings and unchanged diagnostics using the existing authenticated dashboard.
4. Upload the prepared S3 firmware with user permission, without erasing flash. Let it connect and register its boot capability.
5. Test a staged/cancelled change, then a controlled reset-confirmed meter change with the sensor detached. Check history and cumulative energy before reattaching.

Once a replacement has been activated, retain this backend version or a later history-aware version. Rolling back to old ingestion/calculation code would reinterpret mixed-meter usage. Keep the additive database tables and use a forward fix.

## Validation boundaries

Tests exercise the actual migration and analytics SQL in isolated PGlite PostgreSQL, service transaction/rollback contracts, HTTP authentication and ownership rejection, replay and duplicate ingestion, cross-period batches, and reset challenge idempotence. Three existing tests that need a separate PostgreSQL server remain opt-in. Firmware host tests exercise real C++ modules with simulated storage, network and random boot identities. These checks do not prove physical reset behavior, power-loss endurance, sensor accuracy, browser rendering or production migration performance. No production database changes or device upload are part of this branch.

The production build uses Next.js's supported Webpack compiler. Tailwind scans the application directory explicitly so local dependency/build caches are excluded. The Windows Turbopack/PostCSS run stalled; the Webpack production build completed. Application dependency versions and the lockfile remain unchanged.
