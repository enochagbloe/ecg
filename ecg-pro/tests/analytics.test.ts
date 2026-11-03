import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Prisma, type PrismaClient } from "@prisma/client";
import { analyticsQuery, zonedInputToUtc, type Resolution } from "../server/services/analyticsPolicy";
import { queryAnalytics, queryPulseDetails } from "../server/services/analyticsService";
import { powerFromInterval, energyFromPulses } from "../server/services/calculationService";

const db = new PGlite();
// Execute the production parameterized SQL in real WASM PostgreSQL, never a production DB.
const client = { $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows } as unknown as Pick<PrismaClient, "$queryRaw">;
const base = Date.parse("2026-10-01T08:00:00Z");
function query(start: number, end: number, resolution: Resolution = "seconds", timezone = "Africa/Accra") {
  return analyticsQuery(new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), resolution, timezone }));
}
async function pulse(sequence: number, time: number, received = base + 86400000) {
  await db.query('INSERT INTO "PulseEvent" ("deviceId", sequence, "occurredAt", "receivedAt") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', ["test", sequence, new Date(time), new Date(received)]);
}
before(async () => {
  await db.exec('CREATE TABLE "PulseEvent" ("deviceId" text, sequence bigint, "occurredAt" timestamptz, "receivedAt" timestamptz, UNIQUE ("deviceId", sequence)); CREATE INDEX ON "PulseEvent" ("deviceId", "occurredAt");');
});
after(async () => { await db.close(); });

test("1000 and 1600 imp/kWh conversions and interval estimates", () => {
  assert.equal(energyFromPulses(1000n, 1000), 1);
  assert.equal(energyFromPulses(1600n, 1600), 1);
  for (const [ms, kw] of [[3600, 1], [1200, 3], [720, 5], [360, 10], [240, 15]]) assert.equal(powerFromInterval(ms, 1000), kw);
  assert.equal(powerFromInterval(2250, 1600), 1);
  assert.equal(powerFromInterval(0, 1600), 0);
});

test("SQL: intervals split across boundaries; partial buckets use actual duration; replay and duplicate arrivals", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  await pulse(2, base + 3600); // Replay arrives before its predecessor.
  await pulse(1, base);
  await pulse(2, base + 3600); // Same identity is never counted twice.
  const rows = await queryAnalytics(client, "test", 1000, query(base + 500, base + 3500));
  assert.deepEqual(rows.map(r => r.pulseCount), [0, 0, 0, 0]);
  for (const row of rows) assert.ok(Math.abs(row.powerKw! - 1) < 1e-10);
  assert.equal(rows[0].end.getTime() - rows[0].start.getTime(), 500);
  assert.ok(Math.abs(rows.reduce((n, r) => n + r.intervalEnergyKWh, 0) - 3 / 3600) < 1e-10);
  assert.ok(rows.every(r => r.coverage === 1));
  const withPulse = await queryAnalytics(client, "test", 1000, query(base, base + 4000));
  assert.equal(withPulse.reduce((n, r) => n + r.pulseCount, 0), 2);
  assert.equal(withPulse.at(-1)!.powerKw, null); // Never extrapolate after last pulse.
});

test("SQL: energy is invariant across seconds, minutes, hours and days at both meter constants", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  await pulse(3, base + 7200); await pulse(1, base); await pulse(2, base + 3600);
  for (const meter of [1000, 1600]) {
    for (const resolution of ["seconds", "minutes", "hours", "days"] as Resolution[]) {
      const rows = await queryAnalytics(client, "test", meter, query(base, base + 10000, resolution));
      assert.equal(rows.reduce((n, r) => n + r.pulseCount, 0), 3);
      assert.ok(Math.abs(rows.reduce((n, r) => n + r.energyKWh, 0) - 3 / meter) < 1e-10);
    }
  }
});

test("SQL: sequence gaps, clock rollback, zero intervals and long monitoring gaps remain unknown", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  await pulse(1, base); await pulse(2, base); await pulse(4, base + 1000);
  await pulse(5, base + 500); await pulse(6, base + 3600000);
  const rows = await queryAnalytics(client, "test", 1000, query(base, base + 3601000, "minutes"));
  assert.ok(rows.every(r => r.powerKw === null));
  assert.equal(rows.reduce((n, r) => n + r.pulseCount, 0), 5);
});

test("SQL: implausible clocks are excluded, but delayed original measurements stay in history", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  await pulse(1, Date.UTC(2000, 0, 1));
  await pulse(2, base + 1000, base - 3600000); // Clock ahead of receipt.
  await pulse(3, base + 2000, base + 7 * 86400000); // Delayed seven days.
  const rows = await queryAnalytics(client, "test", 1000, query(base, base + 10000));
  assert.equal(rows.reduce((n, r) => n + r.pulseCount, 0), 1);
  assert.equal(rows[2].pulseCount, 1);
});

test("SQL: daily timezone boundaries and daylight-saving days preserve actual bucket duration", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  const start = Date.parse("2026-03-08T05:00:00Z"), end = Date.parse("2026-03-09T04:00:00Z");
  await pulse(1, start, end); await pulse(2, end, end);
  const rows = await queryAnalytics(client, "test", 1000, query(start, end, "days", "America/New_York"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].end.getTime() - rows[0].start.getTime(), 23 * 3600000);
  assert.equal(rows[0].pulseCount, 1); // End is exclusive.
});

test("UTC custom date conversion, range validation and bounded resolutions", () => {
  assert.equal(zonedInputToUtc("2026-10-01T08:00", "Africa/Accra"), "2026-10-01T08:00:00.000Z");
  assert.equal(zonedInputToUtc("2026-10-01T08:00", "America/New_York"), "2026-10-01T12:00:00.000Z");
  assert.throws(() => zonedInputToUtc("2026-03-08T02:30", "America/New_York"));
  assert.throws(() => query(base, base + 86400000, "seconds"), /coarser/);
  assert.throws(() => query(base, base, "days"));
  assert.throws(() => query(base, base + 1000, "seconds", "Invalid/Zone"));
});

test("SQL: pulse inspection is timestamped, calibrated and capped at 200 details", async () => {
  await db.exec('TRUNCATE "PulseEvent"');
  await db.query(`INSERT INTO "PulseEvent" ("deviceId", sequence, "occurredAt", "receivedAt")
    SELECT 'test', i, $1::timestamptz + i * interval '1 second', $2::timestamptz FROM generate_series(1, 250) i`, [new Date(base), new Date(base + 86400000)]);
  const details = await queryPulseDetails(client, "test", 1600, query(base, base + 300000));
  assert.equal(details.truncated, true);
  assert.equal(details.pulses.length, 200);
  assert.equal(details.pulses[0].timestamp, new Date(base + 250000).toISOString());
  assert.equal(details.pulses[0].sequence, "250");
  assert.equal(details.pulses[0].powerKw, 2.25);
  assert.equal(details.pulses[0].energyKWh, 1 / 1600);
  assert.equal(details.pulses[0].intervalSeconds, 1);
  assert.deepEqual(await queryPulseDetails(client, "test", 1600, query(base, base + 300000, "minutes")), { pulses: [], truncated: false });
});
