import type { Device } from "@prisma/client";
import { z } from "zod";
import { authenticateDevice } from "./deviceAuthService";
import { applyPulse, emptyState, serializeState, type StoredState } from "./calculationService";

export const pulseSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  pulse: z.union([z.literal(0), z.literal(1)]),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.string().datetime({ offset: true }),
}).strict();
export type PulseInput = z.infer<typeof pulseSchema>;

export interface PulseTransaction {
  lockDevice(hardwareId: string): Promise<Device | null>;
  getState(deviceId: string): Promise<StoredState | null>;
  hasEvent(deviceId: string, sequence: bigint): Promise<boolean>;
  getEventTime(deviceId: string, sequence: bigint): Promise<Date | null>;
  createEvent(event: { deviceId: string; sequence: bigint; occurredAt: Date; receivedAt: Date }): Promise<void>;
  saveState(deviceId: string, state: StoredState): Promise<void>;
  touchDevice(deviceId: string, receivedAt: Date): Promise<void>;
}
export interface PulseStore {
  transaction<T>(work: (tx: PulseTransaction) => Promise<T>): Promise<T>;
}

export function processPulse(store: PulseStore, input: PulseInput, token: string) {
  return store.transaction(async (tx) => {
    const device = authenticateDevice(await tx.lockDevice(input.deviceId), token);
    const receivedAt = new Date();
    const current = await tx.getState(device.id) ?? emptyState();
    await tx.touchDevice(device.id, receivedAt);

    if (input.pulse === 0) {
      return {
        ok: true as const,
        heartbeat: true as const,
        deviceId: device.hardwareId,
        meterConstant: device.meterConstant,
        state: serializeState(current, device.meterConstant),
      };
    }

    const sequence = BigInt(input.sequence);
    const duplicate = await tx.hasEvent(device.id, sequence);
    let state = current;

    if (!duplicate) {
      const occurredAt = new Date(input.timestamp);
      const previousTime = current.lastSequence === null ? null : await tx.getEventTime(device.id, current.lastSequence);
      const alignedClock = previousTime?.getTime() === current.lastPulseAt?.getTime();
      state = applyPulse(current, sequence, occurredAt, device.meterConstant, alignedClock);
      await tx.createEvent({ deviceId: device.id, sequence, occurredAt, receivedAt });
      await tx.saveState(device.id, state);
    }

    return {
      ok: true as const,
      accepted: true as const,
      duplicate,
      deviceId: device.hardwareId,
      sequence: input.sequence,
      meterConstant: device.meterConstant,
      state: serializeState(state, device.meterConstant),
    };
  });
}

export type PulseResult = Awaited<ReturnType<typeof processPulse>>;

export function pulseBroadcast(result: PulseResult) {
  if (!("duplicate" in result) || result.duplicate) return null;
  return {
    deviceId: result.deviceId,
    pulseCount: result.state.totalPulses,
    timestamp: result.state.lastPulseAt,
    energyKWh: result.state.energyKWh,
    powerKw: result.state.powerKw,
  };
}
