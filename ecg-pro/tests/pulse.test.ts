import assert from "node:assert/strict";
import { test } from "node:test";
import type { Device } from "@prisma/client";
import { energyFromPulses, powerFromInterval, type StoredState } from "../server/services/calculationService";
import { hashSecret } from "../server/services/deviceAuthService";
import { processPulse, pulseBroadcast, pulseSchema, type PulseInput, type PulseStore, type PulseTransaction } from "../server/services/pulseService";
import { HttpError } from "../server/utils/http";

const token = "test-only-high-entropy-device-token-000000000";
const baseTime = Date.parse("2026-09-19T08:00:00.000Z");
function input(sequence = 1, milliseconds = 0, pulse: 0 | 1 = 1): PulseInput {
  return { deviceId: "ECG-001", pulse, sequence, timestamp: new Date(baseTime + milliseconds).toISOString() };
}

// Contract fake: serialize transactions and commit snapshots only on success.
// PostgreSQL row locking is verified separately by the opt-in integration test.
class MemoryStore implements PulseStore {
  device: Device = {
    id: "internal-id", hardwareId: "ECG-001", name: null, apiKeyHash: hashSecret(token),
    meterConstant: 1600, isActive: true, lastSeenAt: null, firmwareVersion: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  state: StoredState | null = null;
  events = new Map<bigint, { occurredAt: Date; receivedAt: Date }>();
  failSave = false;
  private queue = Promise.resolve();
  transaction<T>(work: (tx: PulseTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const device = { ...this.device };
      let state = this.state ? { ...this.state } : null;
      const events = new Map(this.events);
      const tx: PulseTransaction = {
        lockDevice: async (hardwareId) => hardwareId === device.hardwareId ? device : null,
        getState: async () => state,
        hasEvent: async (_id, sequence) => events.has(sequence),
        getEventTime: async (_id, sequence) => events.get(sequence)?.occurredAt ?? null,
        createEvent: async (event) => {
          assert.equal(events.has(event.sequence), false, "unique constraint");
          events.set(event.sequence, event);
        },
        saveState: async (_id, next) => {
          if (this.failSave) throw new Error("simulated write failure");
          state = next;
        },
        touchDevice: async (_id, lastSeenAt) => { device.lastSeenAt = lastSeenAt; },
      };
      const result = await work(tx);
      this.device = device;
      this.state = state;
      this.events = events;
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

test("authoritative pulse energy and consecutive interval power", () => {
  assert.equal(energyFromPulses(1600n, 1600), 1);
  assert.equal(energyFromPulses(1n, 1600), 0.000625);
  assert.equal(powerFromInterval(1000, 1600), 2.25);
  assert.equal(powerFromInterval(3000, 1600), 0.75);
  assert.equal(powerFromInterval(0, 1600), 0);
  assert.equal(powerFromInterval(-1, 1600), 0);
  assert.equal(energyFromPulses(1000n, 1000), 1);
  assert.equal(energyFromPulses(1n, 1000), 0.001);
  assert.equal(energyFromPulses(1n, 800), 0.00125);
  assert.equal(powerFromInterval(1000, 1000), 3.6);
});

test("strict schema rejects authoritative telemetry and malformed values", () => {
  for (const payload of [
    { ...input(), powerKw: 1 }, { ...input(), energyKWh: 1 }, { ...input(), pulse: 2 },
    { ...input(), sequence: -1 }, { ...input(), sequence: 1.5 },
    { ...input(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...input(), timestamp: "yesterday" }, { ...input(), timestamp: "2026-02-30T00:00:00.000Z" },
    { ...input(), deviceId: "" }, { pulse: 1 },
  ]) assert.equal(pulseSchema.safeParse(payload).success, false);
  assert.equal(pulseSchema.safeParse(input()).success, true);
  assert.equal(pulseSchema.safeParse({ ...input(), sequence: 0 }).success, true);
});

test("pulse=1 stores a raw event, first power is zero, server time is distinct", async () => {
  const store = new MemoryStore();
  const result = await processPulse(store, input(), token);
  assert.equal(store.events.size, 1);
  assert.equal(result.state.totalPulses, 1);
  assert.equal(result.state.energyKWh, 0.000625);
  assert.equal(result.state.powerKw, 0);
  assert.equal(store.events.get(1n)?.occurredAt.toISOString(), input().timestamp);
  assert.notEqual(store.events.get(1n)?.receivedAt.toISOString(), input().timestamp);
  assert.equal(pulseBroadcast(result)?.pulseCount, 1);
});

test("heartbeat creates no event/state and does not consume a sequence", async () => {
  const store = new MemoryStore();
  const heartbeat = await processPulse(store, input(1, 0, 0), token);
  assert.equal(store.events.size, 0);
  assert.equal(store.state, null);
  assert.ok(store.device.lastSeenAt);
  assert.equal(heartbeat.state.totalPulses, 0);
  assert.equal(pulseBroadcast(heartbeat), null);
  const pulse = await processPulse(store, input(), token);
  assert.equal(pulse.state.totalPulses, 1);
});

test("duplicate sequence succeeds, leaves energy unchanged and produces no broadcast", async () => {
  const store = new MemoryStore();
  await processPulse(store, input(), token);
  const duplicate = await processPulse(store, input(1, 9999), token);
  assert.equal("duplicate" in duplicate && duplicate.duplicate, true);
  assert.equal(duplicate.state.totalPulses, 1);
  assert.equal(duplicate.state.lastPulseAt, input().timestamp);
  assert.equal(store.events.size, 1);
  assert.equal(pulseBroadcast(duplicate), null);
});

test("invalid secret, unknown hardware ID, and disabled device cannot write", async () => {
  const store = new MemoryStore();
  await assert.rejects(processPulse(store, input(), "wrong"), (error: unknown) => error instanceof HttpError && error.status === 401);
  await assert.rejects(processPulse(store, { ...input(), deviceId: "unknown" }, token), (error: unknown) => error instanceof HttpError && error.status === 401);
  store.device.isActive = false;
  await assert.rejects(processPulse(store, input(), token), (error: unknown) => error instanceof HttpError && error.status === 403);
  assert.equal(store.events.size, 0);
  assert.equal(store.device.lastSeenAt, null);
});

test("consecutive intervals drive power; old missing sequence only adds energy", async () => {
  const store = new MemoryStore();
  await processPulse(store, input(10), token);
  assert.equal((await processPulse(store, input(11, 1000), token)).state.powerKw, 2.25);
  assert.equal((await processPulse(store, input(12, 4000), token)).state.powerKw, 0.75);
  const older = await processPulse(store, input(9, -1000), token);
  assert.equal(older.state.totalPulses, 4);
  assert.equal(older.state.powerKw, 0.75);
  assert.equal(store.state?.lastSequence, 12n);
  assert.equal(older.state.lastPulseAt, input(12, 4000).timestamp);
  assert.equal(store.events.get(9n)?.occurredAt.toISOString(), input(9, -1000).timestamp);
});

test("sequence gaps and clock regressions do not generate misleading power", async () => {
  const store = new MemoryStore();
  await processPulse(store, input(1, 1000), token);
  assert.equal((await processPulse(store, input(3, 2000), token)).state.powerKw, 0);
  assert.equal((await processPulse(store, input(4, 500), token)).state.powerKw, 0);
  assert.equal(store.state?.lastSequence, 4n);
  assert.equal(store.state?.lastPulseAt?.toISOString(), input(3, 2000).timestamp);
  assert.equal((await processPulse(store, input(5, 3000), token)).state.powerKw, 0);
  assert.equal((await processPulse(store, input(6, 4000), token)).state.powerKw, 2.25);
});

test("simultaneous retries count one event under the transaction contract", async () => {
  const store = new MemoryStore();
  const results = await Promise.all(Array.from({ length: 20 }, () => processPulse(store, input(), token)));
  assert.equal(store.events.size, 1);
  assert.equal(store.state?.totalPulses, 1n);
  assert.equal(results.filter((result) => "duplicate" in result && !result.duplicate).length, 1);
});

test("transaction failure rolls back raw event, state, and lastSeenAt", async () => {
  const store = new MemoryStore();
  store.failSave = true;
  await assert.rejects(processPulse(store, input(), token), /simulated write failure/);
  assert.equal(store.events.size, 0);
  assert.equal(store.state, null);
  assert.equal(store.device.lastSeenAt, null);
});
for (const [meterConstant, energy, power] of [
  [800, 0.00125, 4.5],
  [1000, 0.001, 3.6],
  [1600, 0.000625, 2.25],
  [3200, 0.0003125, 1.125],
]) {
  test(`ingestion uses the device's ${meterConstant} imp/kWh calibration`, async () => {
    const store = new MemoryStore();
    store.device.meterConstant = meterConstant;
    const first = await processPulse(store, input(1), token);
    assert.equal(first.state.energyKWh, energy);
    const second = await processPulse(store, input(2, 1000), token);
    assert.equal(second.state.energyKWh, energy * 2);
    assert.equal(second.state.powerKw, power);
    assert.equal(pulseBroadcast(second)?.powerKw, power);
    const heartbeat = await processPulse(store, input(2, 1000, 0), token);
    assert.equal(heartbeat.state.energyKWh, energy * 2);
  });
}