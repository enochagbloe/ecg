import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Device } from "@prisma/client";
import { io as connect } from "socket.io-client";
import { emptyState, type StoredState } from "../server/services/calculationService";
import { resetDeviceTestData, type DeviceResetStore, type DeviceResetTransaction } from "../server/services/deviceResetService";
import { createDeviceResetHandler } from "../server/routes/deviceReset";
import { initializeSocket } from "../server/socketServer";
import { HttpError, json } from "../server/utils/http";
import { createMeterUpdates, type PulseData } from "../app/components/meterUpdates";
import type { DeviceResetEvent } from "../libs/deviceEvents";

class MemoryResetStore implements DeviceResetStore {
  device: Device = {
    id: "internal-1", hardwareId: "ECG-001", name: "Test meter", apiKeyHash: "a".repeat(64),
    meterConstant: 800, isActive: false, firmwareVersion: "1.2", lastSeenAt: new Date(),
    createdAt: new Date("2025-01-01"), updatedAt: new Date(),
  };
  state: StoredState | null = { totalPulses: 5n, lastSequence: 9n, lastPulseAt: new Date(), lastIntervalMs: 1000n, powerKw: 4.5 };
  events = [{ deviceId: "internal-1" }, { deviceId: "other" }];
  fail: "save" | "commit" | null = null;
  committed = false;
  calls = 0;
  async transaction<T>(work: (tx: DeviceResetTransaction) => Promise<T>): Promise<T> {
    this.calls++;
    const device = structuredClone(this.device);
    let state = structuredClone(this.state);
    let events = structuredClone(this.events);
    const result = await work({
      lockDevice: async (id) => id === device.hardwareId ? device : null,
      deleteEvents: async (id) => { events = events.filter((event) => event.deviceId !== id); },
      saveState: async (id, next) => {
        assert.equal(id, device.id);
        if (this.fail === "save") throw new Error("simulated save failure");
        state = next;
      },
      clearLastSeen: async (id) => { assert.equal(id, device.id); device.lastSeenAt = null; },
    });
    if (this.fail === "commit") throw new Error("simulated commit failure");
    this.device = device; this.state = state; this.events = events; this.committed = true;
    return result;
  }
}
const zero = { totalPulses: 0, energyKWh: 0, powerKw: 0, lastPulseAt: null, lastSeenAt: null };
const event: DeviceResetEvent = { deviceId: "ECG-001", pulseCount: 0, energyKWh: 0, powerKw: 0, lastPulseAt: null, lastSeenAt: null };
const old: PulseData = { deviceId: "ECG-001", pulseCount: 5, energyKWh: 5 / 800, powerKw: 4.5, timestamp: "2026-09-19T00:00:00.000Z" };

test("reset clears only measurement data and preserves all device configuration", async () => {
  const store = new MemoryResetStore();
  const before = structuredClone(store.device);
  const result = await resetDeviceTestData(store, "ECG-001");
  assert.deepEqual(result, { ok: true, deviceId: "ECG-001", state: zero });
  assert.deepEqual(store.state, emptyState());
  assert.deepEqual(store.events, [{ deviceId: "other" }]);
  assert.deepEqual(store.device, { ...before, lastSeenAt: null });
  assert.equal(store.committed, true);
});
test("reset upserts missing MeterState and is repeatable", async () => {
  const store = new MemoryResetStore();
  store.state = null;
  await resetDeviceTestData(store, "ECG-001");
  await resetDeviceTestData(store, "ECG-001");
  assert.deepEqual(store.state, emptyState());
});
test("unknown device returns 404 without mutation", async () => {
  const store = new MemoryResetStore();
  await assert.rejects(resetDeviceTestData(store, "missing"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(store.events.length, 2);
  assert.equal(store.committed, false);
});
for (const failure of ["save", "commit"] as const) {
  test(`reset rolls back on ${failure} failure`, async () => {
    const store = new MemoryResetStore();
    const before = structuredClone({ device: store.device, state: store.state, events: store.events });
    store.fail = failure;
    await assert.rejects(resetDeviceTestData(store, "ECG-001"));
    assert.deepEqual({ device: store.device, state: store.state, events: store.events }, before);
    assert.equal(store.committed, false);
  });
}
test("dashboard ignores other devices, resets directly, and rejects stale snapshots", () => {
  const values: PulseData[] = [];
  const updates = createMeterUpdates("ECG-001", (data) => values.push(data));
  updates.pulse(old);
  const stale = updates.beginSnapshot();
  updates.reset({ ...event, deviceId: "other" });
  assert.equal(values.length, 1);
  updates.reset(event);
  assert.deepEqual(values.at(-1), { deviceId: "ECG-001", pulseCount: 0, energyKWh: 0, powerKw: 0, timestamp: null });
  updates.snapshot(stale, old);
  assert.equal(values.length, 2);
  updates.pulse({ ...old, pulseCount: 1 });
  assert.equal(values.at(-1)?.pulseCount, 1);
});
test("reconnect snapshot can recover a reset missed while disconnected", () => {
  const values: PulseData[] = [];
  const updates = createMeterUpdates("ECG-001", (data) => values.push(data));
  updates.pulse(old);
  updates.snapshot(updates.beginSnapshot(), { ...old, pulseCount: 0, energyKWh: 0, powerKw: 0, timestamp: null });
  assert.equal(values.at(-1)?.pulseCount, 0);
});

test("reset HTTP authentication, safety, commit-only broadcast, and real socket delivery", { timeout: 20000 }, async (t) => {
  const previousEnv = process.env;
  process.env = { ...previousEnv, NODE_ENV: "test", ENABLE_TEST_RESET: "false",
    DASHBOARD_USERNAME: "reset-admin", DASHBOARD_PASSWORD: "reset-test-password-at-least-thirty-two-characters" };
  let store = new MemoryResetStore();
  const emitted: DeviceResetEvent[] = [];
  const server = createServer(async (req, res) => {
    try {
      const match = /^\/api\/v1\/devices\/([A-Za-z0-9_-]+)\/reset-test-data$/.exec(new URL(req.url!, "http://localhost").pathname);
      if (!match) throw new HttpError(404, "Not found");
      await createDeviceResetHandler(store, (data) => {
        assert.equal(store.committed, true, "broadcast must follow commit");
        emitted.push(data);
        io.emit("deviceReset", data);
      })(req, res, match[1]);
    } catch (e) { json(res, e instanceof HttpError ? e.status : 500, { ok: false }); }
  });
  const io = initializeSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorization = "Basic " + Buffer.from(`${process.env.DASHBOARD_USERNAME}:${process.env.DASHBOARD_PASSWORD}`).toString("base64");
  const headers = { Authorization: authorization, "X-ECG-Test-Reset": "true" };
  const request = (id = "ECG-001", init: RequestInit = {}) =>
    fetch(`${base}/api/v1/devices/${id}/reset-test-data`, { method: "POST", headers, ...init });
  try {
    await t.test("unauthenticated and device bearer requests are rejected", async () => {
      assert.equal((await request("ECG-001", { headers: {} })).status, 401);
      assert.equal((await request("ECG-001", { headers: { Authorization: "Bearer device-token", "X-ECG-Test-Reset": "true" } })).status, 401);
      assert.equal(store.calls, 0);
    });
    await t.test("wrong method, missing reset header, and cross-origin request are rejected", async () => {
      const wrongMethod = await request("ECG-001", { method: "GET" });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get("allow"), "POST");
      assert.equal((await request("ECG-001", { headers: { Authorization: authorization } })).status, 403);
      assert.equal((await request("ECG-001", { headers: { ...headers, Origin: "https://untrusted.example" } })).status, 403);
      assert.equal(store.calls, 0);
    });
    await t.test("unknown device returns 404 after authentication", async () => {
      assert.equal((await request("missing")).status, 404);
      assert.equal(emitted.length, 0);
    });
    await t.test("failed transaction returns 500 without emitting", async () => {
      store.fail = "commit";
      assert.equal((await request()).status, 500);
      assert.equal(emitted.length, 0);
      assert.equal(store.events.length, 2);
      store.fail = null;
    });
    await t.test("production is disabled unless deliberately enabled", async () => {
      process.env = { ...process.env, NODE_ENV: "production" };
      assert.equal((await request()).status, 404);
      assert.equal(emitted.length, 0);
      process.env.ENABLE_TEST_RESET = "true";
      assert.equal((await request()).status, 200);
      assert.deepEqual(emitted.pop(), event);
      process.env = { ...process.env, NODE_ENV: "test", ENABLE_TEST_RESET: "false" };
      store = new MemoryResetStore();
    });
    await t.test("authenticated reset reaches connected dashboard after commit", async () => {
      const socket = connect(base, { transports: ["websocket"], reconnection: false,
        extraHeaders: { Authorization: authorization } });
      try {
        await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
        let displayed = old;
        const updates = createMeterUpdates("ECG-001", (data) => { displayed = data; });
        updates.pulse(old);
        const received = new Promise<DeviceResetEvent>((resolve) => socket.once("deviceReset", (data: DeviceResetEvent) => {
          updates.reset(data); resolve(data);
        }));
        const response = await request();
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, deviceId: "ECG-001", state: zero });
        assert.deepEqual(await received, event);
        assert.equal(displayed.pulseCount, 0);
        assert.equal(displayed.timestamp, null);
        assert.equal(store.device.meterConstant, 800);
        assert.equal(store.device.apiKeyHash, "a".repeat(64));
        assert.equal(store.device.lastSeenAt, null);
      } finally { socket.disconnect(); }
    });
  } finally {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    server.closeAllConnections();
    process.env = previousEnv;
  }
});