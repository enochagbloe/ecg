import { Prisma, type Device, type PrismaClient } from "@prisma/client";
import type { PulseStore, PulseTransaction } from "./pulseService";

export function createPrismaPulseStore(client: PrismaClient): PulseStore {
  return {
    transaction: (work) => client.$transaction(async (tx) => {
      const store: PulseTransaction = {
        async lockDevice(hardwareId) {
          // Parameterized SQL. Lock Device, not MeterState: the latter may not exist yet.
          const rows = await tx.$queryRaw<Device[]>(Prisma.sql`SELECT * FROM "Device" WHERE "hardwareId" = ${hardwareId} FOR UPDATE`);
          return rows[0] ?? null;
        },
        async samePeriod(deviceId, previous, sequence) {
          if(previous===null)return false;
          const p=await tx.meterPeriod.findFirst({where:{deviceId,startSequence:{lte:sequence}},orderBy:[{startSequence:"desc"},{revision:"desc"}]});
          return previous >= (p?.startSequence ?? 0n);
        },
        async constantForSequence(deviceId, sequence, fallback) {
          const period = await tx.meterPeriod.findFirst({ where: { deviceId, startSequence: { lte: sequence } }, orderBy: [{ startSequence: "desc" }, { revision: "desc" }] });
          return period?.meterConstant ?? fallback;
        },
        getState: (deviceId) => tx.meterState.findUnique({ where: { deviceId } }),
        async hasEvent(deviceId, sequence) {
          return (await tx.pulseEvent.findUnique({ where: { deviceId_sequence: { deviceId, sequence } }, select: { id: true } })) !== null;
        },
        async getEventTime(deviceId, sequence) {
          return (await tx.pulseEvent.findUnique({ where: { deviceId_sequence: { deviceId, sequence } }, select: { occurredAt: true } }))?.occurredAt ?? null;
        },
        async createEvent(data) { await tx.pulseEvent.create({ data }); },
        async getEventTimes(deviceId, sequences) {
          const rows = await tx.pulseEvent.findMany({
            where: { deviceId, sequence: { in: sequences } }, select: { sequence: true, occurredAt: true },
          });
          return new Map(rows.map(row => [row.sequence, row.occurredAt]));
        },
        async createEvents(data) { await tx.pulseEvent.createMany({ data }); },
        async saveState(deviceId, state) {
          await tx.meterState.upsert({ where: { deviceId }, create: { deviceId, ...state }, update: state });
        },
        async touchDevice(id, lastSeenAt) { await tx.device.update({ where: { id }, data: { lastSeenAt } }); },
      };
      return work(store);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 10_000 }),
  };
}
