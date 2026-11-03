import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../libs/prisma";
import { authorizeViewer } from "../services/viewerAuthService";
import { analyticsQuery, maxIntervalSeconds } from "../services/analyticsPolicy";
import { queryAnalytics, queryPulseDetails, type AnalyticsData } from "../services/analyticsService";
import { powerFromInterval } from "../services/calculationService";
import { HttpError, json } from "../utils/http";

export function createDeviceAnalyticsHandler(client: PrismaClient) {
return async function deviceAnalytics(req: IncomingMessage, res: ServerResponse, hardwareId: string) {
  authorizeViewer(req, res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new HttpError(405, "Method not allowed"); }
  const q = analyticsQuery(new URL(req.url!, "http://localhost").searchParams);
  const device = await client.device.findUnique({ where: { hardwareId } });
  if (!device) throw new HttpError(404, "Device not found");
  // A repeatable-read snapshot keeps summary and graph consistent during ingestion/replay.
  const data = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    const rows = await queryAnalytics(tx, device.id, device.meterConstant, q);
    const totals = await tx.$queryRaw<{ today: number; unplaced: number }[]>(Prisma.sql`
      SELECT (SELECT count(*)::int FROM "PulseEvent" WHERE "deviceId" = ${device.id}
        AND "occurredAt" >= (date_trunc('day', now() AT TIME ZONE ${q.timezone}) AT TIME ZONE ${q.timezone})
        AND "occurredAt" <= now() AND "occurredAt" <= "receivedAt" + interval '5 minutes') AS today,
      (SELECT count(*)::int FROM "PulseEvent" WHERE "deviceId" = ${device.id}
        AND "receivedAt" >= ${q.start} AND "receivedAt" < ${q.end}
        AND ("occurredAt" < '2020-01-01'::timestamptz OR "occurredAt" > "receivedAt" + interval '5 minutes')) AS unplaced
    `);
    const latest = await tx.pulseEvent.findFirst({ where: { deviceId: device.id }, orderBy: { sequence: "desc" } });
    const lastReceived = await tx.pulseEvent.findFirst({ where: { deviceId: device.id }, orderBy: { receivedAt: "desc" } });
    const previous = latest ? await tx.pulseEvent.findUnique({ where: { deviceId_sequence: { deviceId: device.id, sequence: latest.sequence - 1n } } }) : null;
    const interval = latest && previous ? latest.occurredAt.getTime() - previous.occurredAt.getTime() : 0;
    const competing = latest && previous && interval > 0 && interval <= maxIntervalSeconds * 1000
      ? await tx.pulseEvent.findFirst({ where: { deviceId: device.id,
        occurredAt: { gte: previous.occurredAt, lte: latest.occurredAt },
        sequence: { notIn: [previous.sequence, latest.sequence] } }, select: { id: true } }) : null;
    const now = Date.now();
    const reliable = [latest, previous].every(e => e && e.occurredAt.getTime() >= Date.UTC(2020, 0, 1) && e.occurredAt.getTime() <= e.receivedAt.getTime() + 300000);
    const fresh = latest && now - latest.occurredAt.getTime() >= 0 && now - latest.occurredAt.getTime() < 90000;
    const online = device.isActive && !!device.lastSeenAt && now - device.lastSeenAt.getTime() < 90000;
    const duration = q.end.getTime() - q.start.getTime();
    const energyKWh = rows.reduce((n, r) => n + r.energyKWh, 0);
    const coverage = rows.reduce((n, r) => n + r.coverage * (r.end.getTime() - r.start.getTime()), 0) / duration;
    const peak = (values: (number | null)[]) => values.some(v => v !== null) ? Math.max(...values.filter((v): v is number => v !== null)) : null;
    return {
      deviceId: hardwareId, meterConstant: device.meterConstant, timezone: q.timezone, resolution: q.resolution,
      pulseDetails: await queryPulseDetails(tx, device.id, device.meterConstant, q),
      buckets: rows.map(r => ({ ...r, start: r.start.toISOString(), end: r.end.toISOString(), firstPulseAt: r.firstPulseAt?.toISOString() ?? null })),
      summary: { energyKWh, todayKWh: totals[0].today / device.meterConstant,
        averageKw: coverage >= 0.999999 ? rows.reduce((n, r) => n + r.intervalEnergyKWh, 0) * 3600000 / duration : null,
        peakIntervalKw: peak(rows.map(r => r.peakKw)), peakBucketKw: peak(rows.map(r => r.powerKw)),
        currentKw: online && fresh && reliable && !competing && interval > 0 && interval <= maxIntervalSeconds * 1000 ? powerFromInterval(interval, device.meterConstant) : null,
        lastPulseAt: latest?.occurredAt.toISOString() ?? null, lastReceivedAt: lastReceived?.receivedAt.toISOString() ?? null,
        online, coverage, unplacedPulses: totals[0].unplaced },
    } satisfies AnalyticsData;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
  json(res, 200, data);
};
}

export const deviceAnalytics = createDeviceAnalyticsHandler(prisma);
