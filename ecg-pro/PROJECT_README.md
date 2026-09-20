# ECG Energy Monitoring System

## Architecture

ECG meter LED → optical sensor → ESP32 → Wi-Fi → authenticated HTTP/HTTPS API → PostgreSQL → backend calculations → Socket.io → web/mobile clients.

Next.js 16 / React 19 supply the existing dashboard. A custom Node HTTP server owns the ingestion routes and shared Socket.io instance. PostgreSQL and Prisma persist every physical pulse and its aggregate state. Production has no serial-port or physically attached Arduino requirement.

The ESP32 sends raw pulses only. It may independently calculate energy/power for its OLED while offline; those local values are never trusted or accepted by the backend.

## Setup

Use Node.js 20.19+ (Node.js 24 is supported).

1. Run `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Supply `DATABASE_URL` for your PostgreSQL database. No real URL or device secret is committed.
4. Generate independent high-entropy secrets (for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). Set `BOOTSTRAP_DEVICE_SECRET` and a different `DASHBOARD_PASSWORD`; both must be at least 32 characters. Set `DASHBOARD_USERNAME`.
5. Set `BOOTSTRAP_DEVICE_ID` and `NEXT_PUBLIC_DEVICE_ID` to the same hardware ID (default `ECG-001`).
6. Set `BOOTSTRAP_METER_CONSTANT` to the imp/kWh value printed on your physical meter (required; no default).
7. Run:

```bash
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

`db:deploy` applies all checked-in migrations, including the migration removing the meter-constant default. This preserves existing calibrations and the positive-value constraint; published migration history remains unchanged. For schema development against a development database, run `npm run db:migrate -- --name describe_change`; Prisma migrate dev requires permission to create/use a shadow database. Do not run migrate dev against production. `npm run db:studio` opens the database editor.

The Prisma CLI, seed, and custom server load `.env.local`, then `.env`, respecting environment variables already supplied by the deployment. Client generation needs no live database. Migrations, seed, and ingestion require a working PostgreSQL connection.

Open http://localhost:3000 and sign in through the browser's HTTP Basic prompt using the dashboard credentials. The server issues an eight-hour signed HttpOnly cookie for same-origin state requests and Socket.io. No device token is exposed to browser code. Missing dashboard credentials fail closed with 503. This single-admin read-access boundary is isolated in `viewerAuthService.ts` for replacement by user sessions and per-device authorization.

## ESP32 pulse API

`POST /api/v1/device/pulse`

Headers:

```http
Content-Type: application/json
Authorization: Bearer <DEVICE_SECRET>
```

Body:

```json
{
  "deviceId": "ECG-001",
  "pulse": 1,
  "sequence": 1847,
  "timestamp": "2026-09-19T08:34:12.438Z"
}
```

Exactly these four keys are accepted. Additional keys, including `powerKw`, `energyKWh`, costs, or analytics, are rejected. JSON bodies are limited to 4096 bytes. Sequence is a non-negative safe JSON integer (maximum 9007199254740991). Timestamp is an ISO 8601 datetime with a timezone. `pulse` must be the number 0 or 1.

The device must persist its monotonically increasing pulse sequence across reboots. Retrying a pulse must preserve its sequence and timestamp. Queue offline events durably and replay them in ascending sequence order. Sequence gaps do not synthesize missing pulses. Keep the device RTC synchronized; timestamps are stored as supplied with millisecond precision.

New pulse response (201):

```json
{
  "ok": true,
  "accepted": true,
  "duplicate": false,
  "deviceId": "ECG-001",
  "sequence": 1847,
  "state": {
    "totalPulses": 1847,
    "energyKWh": 1.154375,
    "powerKw": 0.75,
    "lastPulseAt": "2026-09-19T08:34:12.438Z"
  }
}
```

The totals in this example assume an explicitly configured 1600 imp/kWh meter and 1846 earlier distinct stored pulses. Sequence is an identity, not a total.

A retry returns 200 with `duplicate: true` and current state; it does not create an event, increment energy, or broadcast a new pulse.

Send `pulse: 0` approximately every 30–60 seconds as a heartbeat (with the current pulse sequence). It authenticates, updates `lastSeenAt`, and returns 200:

```json
{
  "ok": true,
  "heartbeat": true,
  "deviceId": "ECG-001",
  "state": { "totalPulses": 0, "energyKWh": 0, "powerKw": 0, "lastPulseAt": null }
}
```

Heartbeats never create PulseEvent records or advance the pulse sequence.

Status codes: 400 invalid schema/JSON; 401 missing or invalid device credentials (unknown device IDs also return 401 to avoid enumeration); 403 disabled authenticated device; 404 unknown route/device on authenticated reads; 405 wrong method; 413 oversized body; 415 unsupported content type/encoding; 500 database/internal error. Retry transient failures using the same sequence.

## Authentication and provisioning

Only SHA-256 hashes of high-entropy device tokens are stored. Comparisons use Node crypto timing-safe comparison. `npm run db:seed` provisions the bootstrap device or rotates its token hash. Rerunning seed preserves history, meter calibration, totals, and active/disabled status. Device tokens must remain secret on the ESP32; logs do not contain authorization headers, bodies, or connection strings.

The dashboard read credential is separate from device write credentials. The authenticated administrator can read all device states and receive all pulse broadcasts; the current UI filters by `NEXT_PUBLIC_DEVICE_ID`. Mobile clients can use dashboard Basic authentication for reads at this stage. Replace the centralized viewer authorization boundary with user access controls before introducing multiple tenants.

## Meter calibration

Read the pulse constant printed on the physical electricity meter, normally marked **imp/kWh**. Meters can use 800, 1000, 1600, or 3200 imp/kWh; there is no universal default.

During provisioning, the user must supply the hardware ID, device secret, and this printed meter constant. Set `BOOTSTRAP_METER_CONSTANT` to that value before seeding; the example value of 1600 is only a sample, not a fallback. Provisioning accepts integers from 1 through 100000 and rejects missing, zero, negative, fractional, non-numeric, and larger values.

The backend stores calibration on each Device and uses `device.meterConstant` for all authoritative energy and power calculations. The state API includes `meterConstant`. The ESP32 may store the same configured value for offline OLED calculations, but its calculated telemetry is not accepted by the backend.

Rerunning seed rotates credentials while preserving the existing meter constant, even if the bootstrap environment value changes. Changing calibration after pulse history exists reinterprets historical energy. Any later change must use a separate, explicit meter replacement/calibration workflow that accounts for history; there is no generic calibration update route.

The shared provisioning contract lives in `server/services/deviceProvisioningService.ts`; future provisioning flows must use its required hardware ID, secret, and validated meter constant.

## Database and calculation rules

- **Device:** unique hardwareId, hashed API key, name/firmware metadata, active flag, liveness, and explicitly configured meter constant (no default).
- **PulseEvent:** device FK, sequence, occurredAt (device/RTC time), receivedAt (server time), createdAt; unique (deviceId, sequence), indexed (deviceId, occurredAt).
- **MeterState:** one row per device; integer totalPulses, maximum sequence, non-regressing lastPulseAt, lastIntervalMs, powerKw, updatedAt. Energy is derived, never accumulated or accepted from devices.

Energy: `energyKWh = totalPulses / meterConstant`.

Power between valid consecutive pulses: `powerKw = 3600000 / (meterConstant * intervalMs)`.

At 1600 imp/kWh, one pulse is 0.000625 kWh; 1600 pulses are 1 kWh; 1000 ms is 2.25 kW; 3000 ms is 0.75 kW. First pulse, sequence gaps, equal timestamps, and clock regressions produce zero power until a valid consecutive interval is available. Power is the latest valid pulse estimate, not an idle-load estimator; heartbeat does not decay it.

Every ingestion transaction locks the Device row with PostgreSQL FOR UPDATE before reading state, checking duplicates, or writing. This serializes concurrent requests across server processes even before MeterState exists; the unique constraint is a second defense. Event creation, state update, and lastSeenAt commit atomically. A failure rolls everything back.

A late missing event contributes to totalPulses and energy, preserving its original occurredAt. It never regresses lastSequence/lastPulseAt or replaces current power. For high sequences with a regressed RTC, power remains zero until timestamps align again. Meter constants should be treated as fixed calibration once history exists; changing them reinterprets total energy.

Counts/sequences use PostgreSQL BIGINT; API numbers stay within JavaScript's safe integer range. The migration includes positive calibration and non-negative state constraints.

## State and realtime APIs

`GET /api/v1/devices/:deviceId/state` requires viewer authentication and returns:

```json
{
  "deviceId": "ECG-001",
  "online": true,
  "totalPulses": 1847,
  "energyKWh": 1.154375,
  "powerKw": 0.75,
  "lastPulseAt": "2026-09-19T08:34:12.438Z",
  "lastSeenAt": "2026-09-19T08:34:12.500Z",
  "meterConstant": 1600
}
```

Online means active and seen within the last 90 seconds. Unused devices return zero totals and null timestamps. Responses are not cached.

After a successful new pulse commit, Socket.io emits `pulseData`:

```typescript
{ deviceId, pulseCount, timestamp, energyKWh, powerKw }
```

pulseCount is the database total, timestamp is the state's lastPulseAt, and energy/power are backend calculations. Heartbeats and duplicates do not emit pulseData. The dashboard loads saved state on mount and reconnect, then receives live updates; it filters other devices and ignores regressing pulse counts. Its appearance remains unchanged.

Socket delivery is best effort after commit, not a durable queue. A process failure after commit can miss a broadcast; HTTP retry remains idempotent and state fetch/reconnect recovers totals. Use one custom server instance for now; multiple server instances need a shared Socket.io adapter for fanout (database counting is already safe across processes).

## Production and verification

Use HTTPS via a reverse proxy in production (the session cookie is Secure in production), forward WebSocket upgrades, preserve Authorization headers, and set `NEXT_PUBLIC_APP_URL` to the exact browser origin. Apply appropriate rate limits at the proxy. Build-time `NEXT_PUBLIC_DEVICE_ID` selects the dashboard device. Run the custom server; standalone `next start` does not expose ingestion or the shared socket.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Database-independent tests cover formulas, validation, device authentication, heartbeat behavior, deduplication, replay ordering, clock regression, and rollback. The concurrency integration test is skipped unless `TEST_DATABASE_URL` explicitly points to a separately migrated test database; it creates temporary devices and deletes their data afterward. It never falls back to the production DATABASE_URL.

Client generation and unit tests are not proof that migrations or PostgreSQL integration have succeeded. Apply the migration and seed after supplying a real URL, and run the opt-in test against a test database.

## Main files

- `server/index.ts`: Node/Next request dispatch and lifecycle.
- `server/routes/`: pulse and latest-state HTTP handlers.
- `server/services/`: authentication, calculations, ingestion transaction, Prisma storage.
- `server/socketServer.ts`: authenticated realtime transport.
- `libs/prisma.ts`: development-safe shared Prisma client.
- `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`: database lifecycle.
- `app/components/ECGMonitor.tsx`: existing dashboard with state hydration.
## Development/test data reset

With the custom backend running, use:

```bash
pnpm reset:test-data ECG-001
```

The script loads dashboard credentials from `.env.local` and calls the running backend, never Prisma directly. The device argument can be omitted when `BOOTSTRAP_DEVICE_ID` is set. `RESET_API_URL` defaults to `http://localhost:3000`; remote URLs must use HTTPS. Requests do not follow redirects, and credentials are never printed.

Endpoint: `POST /api/v1/devices/:deviceId/reset-test-data`

Use the existing dashboard Basic credentials or authenticated viewer session, plus `X-ECG-Test-Reset: true`. ESP32 Bearer tokens cannot authorize this operation. Cross-origin browser requests are rejected. Wrong methods return 405 with `Allow: POST`; authenticated unknown devices return 404.

This destructive endpoint is for test/development cleanup. It is available in development; in production it returns 404 unless the server has deliberately been started with `ENABLE_TEST_RESET=true` (default false). Authentication and the reset header are required even when enabled.

One transaction locks the Device row using the same lock as pulse ingestion, deletes that device's PulseEvent history, upserts a zero/null MeterState, and clears lastSeenAt. Device identity, API key hash, meter constant, active status, name, firmware, and creation date are preserved. No schema migration is needed.

After commit the shared Socket.io server broadcasts `deviceReset`:

```json
{"deviceId":"ECG-001","pulseCount":0,"energyKWh":0,"powerKw":0,"lastPulseAt":null,"lastSeenAt":null}
```

The HTTP response is 200:

```json
{"ok":true,"deviceId":"ECG-001","state":{"totalPulses":0,"energyKWh":0,"powerKw":0,"lastPulseAt":null,"lastSeenAt":null}}
```

Connected dashboards for that device immediately update React state to zeros/nulls, with no browser reload. Other devices are ignored. Stale in-flight state fetches cannot overwrite the reset; reconnecting loads an authoritative snapshot even when its count is lower. The connection indicator continues to describe the socket connection, not device liveness.

A failed transaction rolls back and emits no reset event. Delivery is best effort after commit, as with pulseData; reconnect recovers missed events. Pause the test sender and clear its queued test pulses before resetting: history deletion also removes sequence deduplication records, so replayed pulses or new pulses can increase totals again. Do not use this operation to clear real production measurement history.