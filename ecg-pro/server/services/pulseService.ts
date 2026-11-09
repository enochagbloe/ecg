import type { Device } from "@prisma/client";
import { z } from "zod";
import { authenticateDevice } from "./deviceAuthService";
import { applyPulse, emptyState, serializeState, type StoredState } from "./calculationService";
import { HttpError } from "../utils/http";

export const pulseSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  pulse: z.union([z.literal(0), z.literal(1)]),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.string().datetime({ offset: true }),
}).strict();
export type PulseInput = z.infer<typeof pulseSchema>;
export const MAX_PULSE_BATCH = 50;
const batchEvent = pulseSchema.pick({ sequence: true, timestamp: true }).strict();
export const pulseBatchSchema = pulseSchema.pick({ deviceId: true }).extend({
  events: z.array(batchEvent).min(1).max(MAX_PULSE_BATCH),
}).strict().refine(({ events }) => events.every((event, i) =>
  event.sequence > 0 && (i === 0 || event.sequence === events[i - 1].sequence + 1)),
"Batch sequences must be positive and contiguous");

export interface PulseTransaction {
  lockDevice(hardwareId: string): Promise<Device | null>;
  getState(deviceId: string): Promise<StoredState | null>;
  hasEvent(deviceId: string, sequence: bigint): Promise<boolean>;
  getEventTime(deviceId: string, sequence: bigint): Promise<Date | null>;
  createEvent(event: { deviceId: string; sequence: bigint; occurredAt: Date; receivedAt: Date }): Promise<void>;
  saveState(deviceId: string, state: StoredState): Promise<void>;
  touchDevice(deviceId: string, receivedAt: Date): Promise<void>;
  getEventTimes?(deviceId: string, sequences: bigint[]): Promise<Map<bigint, Date>>;
  createEvents?(events: Array<{ deviceId: string; sequence: bigint; occurredAt: Date; receivedAt: Date }>): Promise<void>;
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
        maxBatchSize: MAX_PULSE_BATCH,
        // Sequence identities are independent of cumulative pulse totals.
        lastSequence: current.lastSequence === null ? null : Number(current.lastSequence),
        state: serializeState(current, device.meterConstant),
      };
    }

    const sequence = BigInt(input.sequence);
    const duplicate = await tx.hasEvent(device.id, sequence);
    // Supply the original timestamp so firmware can distinguish safe retries
    // from new optical events accidentally reusing an old sequence number.
    const existingTime = duplicate ? await tx.getEventTime(device.id, sequence) : null;
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
      ...(duplicate ? { existingTimestamp: existingTime?.toISOString() ?? null } : {}),
      deviceId: device.hardwareId,
      sequence: input.sequence,
      meterConstant: device.meterConstant,
      state: serializeState(state, device.meterConstant),
    };
  });
}

export function processPulseBatch(store: PulseStore, input: z.infer<typeof pulseBatchSchema>, token: string) {
  // Validate at the service boundary as well as the HTTP boundary.
  const { deviceId, events } = pulseBatchSchema.parse(input);
  return store.transaction(async (tx) => {
    const device = authenticateDevice(await tx.lockDevice(deviceId), token);
    const receivedAt = new Date();
    let state = await tx.getState(device.id) ?? emptyState();
    const sequences = events.map(event => BigInt(event.sequence));
    const lookups = state.lastSequence === null ? sequences : [...sequences, state.lastSequence];
    const times = tx.getEventTimes ? await tx.getEventTimes(device.id, lookups) : new Map<bigint, Date>();
    if (!tx.getEventTimes) {
      for (const sequence of new Set(lookups)) {
        const time = await tx.getEventTime(device.id, sequence);
        if (time) times.set(sequence, time);
      }
    }
    const inserts = [];
    for (const event of events) {
      const sequence = BigInt(event.sequence);
      const occurredAt = new Date(event.timestamp);
      const existing = times.get(sequence);
      if (existing) {
        if (existing.getTime() !== occurredAt.getTime()) throw new HttpError(409, "Pulse sequence timestamp conflict");
        continue;
      }
      const previous = state.lastSequence === null ? undefined : times.get(state.lastSequence);
      state = applyPulse(state, sequence, occurredAt, device.meterConstant,
        previous?.getTime() === state.lastPulseAt?.getTime());
      times.set(sequence, occurredAt);
      inserts.push({ deviceId: device.id, sequence, occurredAt, receivedAt });
    }
    if (inserts.length) {
      if (tx.createEvents) await tx.createEvents(inserts);
      else for (const event of inserts) await tx.createEvent(event);
      await tx.saveState(device.id, state);
    }
    await tx.touchDevice(device.id, receivedAt);
    return {
      ok: true as const, deviceId: device.hardwareId, meterConstant: device.meterConstant,
      firstSequence: events[0].sequence, ackThrough: events[events.length - 1].sequence,
      acknowledged: events.length, inserted: inserts.length,
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
