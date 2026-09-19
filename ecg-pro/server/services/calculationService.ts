import type { MeterState } from "@prisma/client";

export type StoredState = Pick<MeterState,
  "totalPulses" | "lastSequence" | "lastPulseAt" | "lastIntervalMs" | "powerKw">;

export function emptyState(): StoredState {
  return { totalPulses: 0n, lastSequence: null, lastPulseAt: null, lastIntervalMs: null, powerKw: 0 };
}

export function energyFromPulses(totalPulses: bigint, meterConstant: number): number {
  if (!Number.isInteger(meterConstant) || meterConstant <= 0) throw new Error("Invalid meter constant");
  if (totalPulses < 0n || totalPulses > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Pulse count outside JSON safe integer range");
  return Number(totalPulses) / meterConstant;
}

export function powerFromInterval(intervalMs: number, meterConstant: number): number {
  if (!Number.isInteger(meterConstant) || meterConstant <= 0) throw new Error("Invalid meter constant");
  return intervalMs > 0 ? 3_600_000 / (meterConstant * intervalMs) : 0;
}

export function applyPulse(state: StoredState, sequence: bigint, occurredAt: Date, meterConstant: number, alignedClock: boolean): StoredState {
  const next = { ...state, totalPulses: state.totalPulses + 1n };
  energyFromPulses(next.totalPulses, meterConstant);
  // Older missing events contribute energy only, never live power or the sequence head.
  if (state.lastSequence !== null && sequence <= state.lastSequence) return next;

  const interval = state.lastPulseAt ? occurredAt.getTime() - state.lastPulseAt.getTime() : 0;
  const consecutive = alignedClock && state.lastSequence !== null && sequence === state.lastSequence + 1n;
  next.lastSequence = sequence;
  next.lastIntervalMs = consecutive && interval > 0 ? BigInt(interval) : null;
  next.powerKw = next.lastIntervalMs === null ? 0 : powerFromInterval(interval, meterConstant);
  if (!state.lastPulseAt || occurredAt > state.lastPulseAt) next.lastPulseAt = occurredAt;
  return next;
}

export function serializeState(state: StoredState, meterConstant: number) {
  return {
    totalPulses: Number(state.totalPulses),
    energyKWh: energyFromPulses(state.totalPulses, meterConstant),
    powerKw: state.powerKw,
    lastPulseAt: state.lastPulseAt?.toISOString() ?? null,
  };
}