# Web electricity analytics

Implemented in the existing Next.js dashboard and custom Node HTTP server. Optical diagnostics, stored lifetime counters, ingestion, sequence deduplication, customer authentication and firmware are unchanged.

## API and controls

`GET /api/v1/devices/:hardwareId/analytics?start=<UTC ISO>&end=<UTC ISO>&resolution=seconds|minutes|hours|days&timezone=Africa/Accra`

Uses the same signed dashboard-viewer session/Basic authentication as the existing dashboard device-state endpoint. It is not a customer mobile API; no customer/device ownership boundary was broadened. Responses are private, uncached snapshots. Start is inclusive and end exclusive. All database timestamps remain UTC. The selected IANA timezone controls display, custom input interpretation, today's energy and calendar-day bucket boundaries. Nonexistent DST local input is rejected; an ambiguous repeated local time resolves deterministically to one matching UTC instant. Use explicit UTC via the API to disambiguate repeated times.

Ranges are limited to 366 days and 1,800 buckets. The UI automatically coarsens an unreasonable resolution and explains the adjustment; direct API requests receive HTTP 400. Seconds, minutes and hours align to UTC boundaries; days align to local midnight and use the actual duration on 23/25-hour DST days. Edge buckets are clipped to the selected range.

The dashboard opens on a full-width Overview with current load, today's energy, range energy and peak demand. A separate Diagnostics tab contains optical diagnostics and lifetime device counters; panels remain mounted to preserve subscriptions and state. The default view covers 24 hours at minute resolution. Live monitoring and custom filtering remain available.

Recharts renders power as a filled stepped area and bucket energy as columns, with adaptive time labels, a detailed hover card, peak marker, keyboard navigation and a draggable time navigator. Gaps are preserved, and interpolation does not smooth away real load changes. Range average, peak bucket average, coverage and last measurement sit below the graph. Advanced resolution, timezone and calculation controls live under View settings. Second-resolution responses also include up to 200 exact pulse details in the expandable Pulse explorer, with a truncation indicator. Narrow the time range to inspect earlier pulses.

## Calculations and missing data

Calibration always comes from `Device.meterConstant`; no global fallback is introduced.

- Recorded energy: unique measured pulse count / meter constant (kWh).
- Interval-estimated power: `3600 / (meterConstant * intervalSeconds)` (kW). This is the mean over the interval between pulses, not an instantaneous measurement.
- Bucket-average power: each valid pulse-to-pulse interval contributes `(overlapSeconds / intervalSeconds) / meterConstant` kWh to each intersected bucket; divide the sum by the actual bucket duration in hours.
- Entire-range average: sum of those apportioned interval energies divided by range hours, available only when the entire range has valid interval coverage. This deliberately differs from pulse-count energy / duration at clipped interval boundaries, where counting the whole pulse would create misleading spikes.
- Peak interval power and peak bucket-average power are reported separately. The chart can show either. The first measured pulse timestamp and shortest overlapping interval are available in bucket inspection; the pulse table provides original timestamps and sequence identities.

An interval is usable only with consecutive sequence IDs, increasing timestamps, plausible clocks, no competing events within its boundaries, and duration at most 15 minutes. Longer intervals remain uncertain: historical data cannot distinguish a long low-load interval from loss of observation. Buckets without complete interval coverage have null average power; no extrapolation occurs after the last pulse. Empty energy buckets are drawn as gaps, not zero measurements. Recorded energy is the sum of observed pulses, not a claim that monitoring captured all consumption. Current power becomes unavailable when the meter is offline or the last measurement is over 90 seconds old.

Timestamps before 2020 or more than five minutes ahead of receipt are excluded from timed analytics. The API counts these clock-invalid pulses by upload time within the selected range, and the UI flags them. Lifetime counters remain untouched. Old/replayed measurements are placed by `occurredAt`, never `receivedAt`. Receipt timestamps are exposed separately for diagnostics.

**Existing data limits:** events do not persist RTC/NTP synchronization, monotonic pulse timing, heartbeat history, calibration history or an explicit monitoring-coverage flag. Plausible but wrong clocks cannot be detected reliably; no historical timestamp is silently corrected. Offline status comes from current heartbeat freshness, not reconstructed historical connectivity. Historical intervals are observational estimates, not proof of continuous sensor operation. A calibration change would reinterpret existing history; use a separate device record for a changed meter until calibration history exists. The original firmware's timestamp precision bounds the estimates; zero-length intervals are not converted to power. No firmware changes are part of this feature.

## Live updates and query efficiency

Existing authenticated Socket.IO `pulseData` and `deviceReset` events invalidate the analytics snapshot, coalesced to at most once a second; polling every 15 seconds also reconciles heartbeat status and missed messages. In-flight refreshes are not interrupted by pulse bursts. Settings and zoom persist. Snapshot replacement, rather than incrementing counters in the client, avoids replay/reconnect double counting. Settings changes abort stale fetches.

PostgreSQL performs grouping and interval apportionment; no unbounded raw event list is sent to the browser. The existing unique device/sequence index excludes duplicates and supports predecessor lookup; the device/measurement-time index bounds range scans. Interval segments are generated only for the buckets they overlap, rather than rescanning every event for every bucket. Queries run in a repeatable-read transaction with a 10-second statement timeout and 15-second transaction timeout. Large histories still require scanning the selected range; precomputed rollups are not introduced, and unusually large histories may time out and show an error rather than return partial/fabricated results.

## Additive migration and release

`prisma/migrations/20261103000000_analytics_received_index/migration.sql` adds `(deviceId, receivedAt)` for bounded receipt-time quality queries. No columns or data are removed or rewritten. Run the usual `pnpm db:deploy` against the target database before release. On large production tables, schedule index creation in an appropriate maintenance window; the ordinary index creation can temporarily block writes. This implementation applied migrations only to an isolated local validation database, not production.

## Verification

- `pnpm db:generate`: passed.
- `pnpm db:deploy`: all four migrations applied to isolated PostgreSQL 18.
- `pnpm typecheck`: passed. Existing typed fixtures were updated for the current Device schema and Next.js environment types.
- `pnpm lint`: passed with five existing warnings in `injest/test.ts`, `scripts/set-customer-password.ts`, and `server/routes/customerAuth.ts`.
- `TEST_DATABASE_URL=<isolated local database> pnpm test`: 58 passed, zero failed or skipped. Includes existing authentication, ingestion/deduplication, reset/socket, provisioning and customer tests; new tests execute production SQL in PGlite and the full analytics HTTP route in native PostgreSQL.
- `pnpm build`: production Next.js build passed. Existing Google-font downloads require network access. Existing baseline-browser-mapping age warnings remain.
- Browser visual verification: unavailable. Browser tools report local browser use disabled; the desktop fallback was stopped because computer-use could not verify the browser URL with enough confidence to enforce policy. No further browser interaction was attempted. Responsive/dark styling and keyboard/pointer handlers were reviewed in source; a browser interaction/accessibility audit remains a release follow-up.

PGlite is a development-only dependency used to execute actual PostgreSQL queries without external database credentials; see its [API documentation](https://pglite.dev/docs/api). Test data is isolated from production and is never used as a substitute for actual dashboard measurements.
