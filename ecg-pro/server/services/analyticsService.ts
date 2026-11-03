import { Prisma, type PrismaClient } from "@prisma/client";
import { maxIntervalSeconds, resolutions, type analyticsQuery } from "./analyticsPolicy";

type Query = ReturnType<typeof analyticsQuery>;
type Row = { start: Date; end: Date; firstPulseAt: Date | null; pulseCount: number; energyKWh: number; intervalEnergyKWh: number; powerKw: number | null; coverage: number; peakKw: number | null; intervalSeconds: number | null };

// All raw events stay in PostgreSQL. Existing (deviceId, occurredAt) and unique
// (deviceId, sequence) indexes bound range scans and predecessor lookups.
export async function queryAnalytics(client: Pick<PrismaClient, "$queryRaw">, deviceId: string, meterConstant: number, q: Query) {
  const step = resolutions[q.resolution];
  const buckets = q.resolution === "days"
    ? Prisma.sql`SELECT t AT TIME ZONE ${q.timezone} AS key, greatest(t AT TIME ZONE ${q.timezone}, ${q.start}) AS start,
        least((t + interval '1 day') AT TIME ZONE ${q.timezone}, ${q.end}) AS finish
        FROM generate_series(date_trunc('day', ${q.start}::timestamptz AT TIME ZONE ${q.timezone}),
        date_trunc('day', ${q.end}::timestamptz AT TIME ZONE ${q.timezone}), interval '1 day') t`
    : Prisma.sql`SELECT t AS key, greatest(t, ${q.start}) AS start, least(t + ${step} * interval '1 second', ${q.end}) AS finish
        FROM generate_series(date_bin(${step} * interval '1 second', ${q.start}::timestamptz, '2000-01-01'::timestamptz),
        ${q.end}::timestamptz, ${step} * interval '1 second') t`;
  const eventKey = q.resolution === "days"
    ? Prisma.sql`date_trunc('day', e."occurredAt" AT TIME ZONE ${q.timezone}) AT TIME ZONE ${q.timezone}`
    : Prisma.sql`date_bin(${step} * interval '1 second', e."occurredAt", '2000-01-01'::timestamptz)`;
  const segments = q.resolution === "days"
    ? Prisma.sql`SELECT t AT TIME ZONE ${q.timezone} AS key, (t + interval '1 day') AT TIME ZONE ${q.timezone} AS finish
        FROM generate_series(date_trunc('day', greatest(v.start, ${q.start}) AT TIME ZONE ${q.timezone}),
          date_trunc('day', (least(v.finish, ${q.end}) - interval '1 microsecond') AT TIME ZONE ${q.timezone}), interval '1 day') t`
    : Prisma.sql`SELECT t AS key, t + ${step} * interval '1 second' AS finish
        FROM generate_series(date_bin(${step} * interval '1 second', greatest(v.start, ${q.start}), '2000-01-01'::timestamptz),
          date_bin(${step} * interval '1 second', least(v.finish, ${q.end}) - interval '1 microsecond', '2000-01-01'::timestamptz), ${step} * interval '1 second') t`;
  return client.$queryRaw<Row[]>(Prisma.sql`
    WITH buckets AS (${buckets}),
    events AS MATERIALIZED (
      SELECT e.* FROM "PulseEvent" e WHERE e."deviceId" = ${deviceId}
        AND e."occurredAt" >= ${q.start}::timestamptz - ${maxIntervalSeconds} * interval '1 second'
        AND e."occurredAt" < ${q.end}::timestamptz + ${maxIntervalSeconds} * interval '1 second'
        AND e."occurredAt" >= '2020-01-01'::timestamptz
        AND e."occurredAt" <= e."receivedAt" + interval '5 minutes'
    ), intervals AS MATERIALIZED (
      SELECT e."occurredAt" AS finish, p."occurredAt" AS start,
        extract(epoch FROM e."occurredAt" - p."occurredAt")::float8 AS seconds
      FROM events e JOIN "PulseEvent" p ON p."deviceId" = ${deviceId} AND p.sequence = e.sequence - 1
      WHERE p."occurredAt" >= '2020-01-01'::timestamptz
        AND p."occurredAt" <= p."receivedAt" + interval '5 minutes'
        AND e."occurredAt" > p."occurredAt"
        AND e."occurredAt" - p."occurredAt" <= ${maxIntervalSeconds} * interval '1 second'
        AND e."occurredAt" > ${q.start} AND p."occurredAt" < ${q.end}
        -- Reject intervals overlapping a different sequence's measurement after clock rollback.
        AND NOT EXISTS (SELECT 1 FROM "PulseEvent" x WHERE x."deviceId" = ${deviceId}
          AND x."occurredAt" >= p."occurredAt" AND x."occurredAt" <= e."occurredAt"
          AND x.sequence <> e.sequence AND x.sequence <> p.sequence)
    ), counts AS (
      SELECT ${eventKey} AS key, count(*) AS n, min(e."occurredAt") AS first FROM events e
      WHERE e."occurredAt" >= ${q.start} AND e."occurredAt" < ${q.end} GROUP BY 1
    ), apportioned AS (
      SELECT s.key,
        sum(extract(epoch FROM least(v.finish, s.finish, ${q.end}) - greatest(v.start, s.key, ${q.start}))) AS covered,
        sum(extract(epoch FROM least(v.finish, s.finish, ${q.end}) - greatest(v.start, s.key, ${q.start})) / v.seconds / ${meterConstant}) AS energy,
        max(3600 / (${meterConstant} * v.seconds)) AS peak, min(v.seconds) AS shortest
      FROM intervals v CROSS JOIN LATERAL (${segments}) s GROUP BY s.key
    )
    SELECT b.start, b.finish AS end, c.first AS "firstPulseAt", coalesce(c.n, 0)::int AS "pulseCount",
      coalesce(c.n, 0)::float8 / ${meterConstant} AS "energyKWh", coalesce(i.energy, 0)::float8 AS "intervalEnergyKWh",
      CASE WHEN coalesce(i.covered, 0) >= extract(epoch FROM b.finish - b.start) - 0.000001
        THEN i.energy * 3600 / extract(epoch FROM b.finish - b.start) ELSE NULL END::float8 AS "powerKw",
      least(1, coalesce(i.covered, 0) / extract(epoch FROM b.finish - b.start))::float8 AS coverage,
      i.peak::float8 AS "peakKw", i.shortest::float8 AS "intervalSeconds"
    FROM buckets b LEFT JOIN counts c ON c.key = b.key LEFT JOIN apportioned i ON i.key = b.key
    WHERE b.finish > b.start ORDER BY b.start
  `);
}

export type AnalyticsBucket = Omit<Row, "start" | "end" | "firstPulseAt"> & { start: string; end: string; firstPulseAt: string | null };
export type PulseDetail = { sequence: string; timestamp: string; receivedAt: string; intervalSeconds: number | null; powerKw: number | null; energyKWh: number };

export async function queryPulseDetails(client: Pick<PrismaClient, "$queryRaw">, deviceId: string, meterConstant: number, q: Query) {
  if (q.resolution !== "seconds") return { pulses: [] as PulseDetail[], truncated: false };
  const rows = await client.$queryRaw<{ sequence: string; occurredAt: Date; receivedAt: Date; intervalSeconds: number | null }[]>(Prisma.sql`
    WITH recent AS (
      SELECT * FROM "PulseEvent" WHERE "deviceId" = ${deviceId} AND "occurredAt" >= ${q.start} AND "occurredAt" < ${q.end}
        AND "occurredAt" >= '2020-01-01'::timestamptz AND "occurredAt" <= "receivedAt" + interval '5 minutes'
      ORDER BY "occurredAt" DESC, sequence DESC LIMIT 201
    )
    SELECT e.sequence::text, e."occurredAt", e."receivedAt",
      CASE WHEN p."occurredAt" >= '2020-01-01'::timestamptz AND p."occurredAt" <= p."receivedAt" + interval '5 minutes'
        AND e."occurredAt" > p."occurredAt" AND e."occurredAt" - p."occurredAt" <= ${maxIntervalSeconds} * interval '1 second'
        AND NOT EXISTS (SELECT 1 FROM "PulseEvent" x WHERE x."deviceId" = ${deviceId}
          AND x."occurredAt" >= p."occurredAt" AND x."occurredAt" <= e."occurredAt" AND x.sequence NOT IN (p.sequence, e.sequence))
        THEN extract(epoch FROM e."occurredAt" - p."occurredAt")::float8 ELSE NULL END AS "intervalSeconds"
    FROM recent e LEFT JOIN "PulseEvent" p ON p."deviceId" = ${deviceId} AND p.sequence = e.sequence - 1
    ORDER BY e."occurredAt" DESC, e.sequence DESC
  `);
  return { pulses: rows.slice(0, 200).map(r => ({ sequence: r.sequence, timestamp: r.occurredAt.toISOString(), receivedAt: r.receivedAt.toISOString(),
    intervalSeconds: r.intervalSeconds, powerKw: r.intervalSeconds === null ? null : 3600 / (meterConstant * r.intervalSeconds), energyKWh: 1 / meterConstant })), truncated: rows.length > 200 };
}

export interface AnalyticsData {
  deviceId: string; meterConstant: number; timezone: string; resolution: string;
  buckets: AnalyticsBucket[];
  pulseDetails: { pulses: PulseDetail[]; truncated: boolean };
  summary: { energyKWh: number; todayKWh: number; averageKw: number | null; peakIntervalKw: number | null;
    peakBucketKw: number | null; currentKw: number | null; lastPulseAt: string | null; lastReceivedAt: string | null;
    online: boolean; coverage: number; unplacedPulses: number };
}
