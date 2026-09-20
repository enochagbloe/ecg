import { Prisma, type PrismaClient } from "@prisma/client";
import { emptyState } from "./calculationService";
import type { StoredState } from "./calculationService";
import { HttpError } from "../utils/http";

export interface DeviceResetTransaction {
  lockDevice(hardwareId: string): Promise<{ id: string; hardwareId: string } | null>;
  deleteEvents(deviceId: string): Promise<void>;
  saveState(deviceId: string, state: StoredState): Promise<void>;
  clearLastSeen(deviceId: string): Promise<void>;
}
export interface DeviceResetStore {
  transaction<T>(work: (tx: DeviceResetTransaction) => Promise<T>): Promise<T>;
}

export function createPrismaDeviceResetStore(client: PrismaClient): DeviceResetStore {
  return {
    transaction: (work) => client.$transaction(async (tx) => work({
      async lockDevice(hardwareId) {
        // Same lock as ingestion, including when MeterState is absent.
        const rows = await tx.$queryRaw<{ id: string; hardwareId: string }[]>(
          Prisma.sql`SELECT "id", "hardwareId" FROM "Device" WHERE "hardwareId" = ${hardwareId} FOR UPDATE`);
        return rows[0] ?? null;
      },
      async deleteEvents(deviceId) { await tx.pulseEvent.deleteMany({ where: { deviceId } }); },
      async saveState(deviceId, state) {
        await tx.meterState.upsert({ where: { deviceId }, create: { deviceId, ...state }, update: state });
      },
      async clearLastSeen(id) { await tx.device.update({ where: { id }, data: { lastSeenAt: null } }); },
    }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 10_000 }),
  };
}

export function resetDeviceTestData(store: DeviceResetStore, hardwareId: string) {
  return store.transaction(async (tx) => {
    const device = await tx.lockDevice(hardwareId);
    if (!device) throw new HttpError(404, "Device not found");
    await tx.deleteEvents(device.id);
    await tx.saveState(device.id, emptyState());
    await tx.clearLastSeen(device.id);
    return {
      ok: true as const, deviceId: device.hardwareId,
      state: { totalPulses: 0 as const, energyKWh: 0 as const, powerKw: 0 as const,
        lastPulseAt: null, lastSeenAt: null },
    };
  });
}