import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { createDeviceAnalyticsHandler } from "../server/routes/deviceAnalytics";
import { HttpError, json } from "../server/utils/http";
import { processPulse } from "../server/services/pulseService";
import { createPrismaPulseStore } from "../server/services/prismaPulseStore";
import { hashSecret } from "../server/services/deviceAuthService";
import type { AnalyticsData } from "../server/services/analyticsService";

test("PostgreSQL HTTP analytics: authentication, bounded queries, replay reconciliation and current status", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const hardwareId = "analytics-" + randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  const oldUser = process.env.DASHBOARD_USERNAME, oldPass = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME = "analytics-test";
  process.env.DASHBOARD_PASSWORD = "analytics-test-password-which-is-at-least-32-characters";
  const device = await client.device.create({ data: { hardwareId, apiKeyHash: hashSecret(token), meterConstant: 1000 } });
  const handler = createDeviceAnalyticsHandler(client);
  const server = createServer((req, res) => { void handler(req, res, hardwareId).catch(e => json(res, e instanceof HttpError ? e.status : 500, { error: e.message })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: "Basic " + Buffer.from(`${process.env.DASHBOARD_USERNAME}:${process.env.DASHBOARD_PASSWORD}`).toString("base64") };
  const now = Date.now(), start = now - 10000;
  const parameters = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(now).toISOString(), resolution: "seconds", timezone: "Africa/Accra" });
  const url = origin + "/?" + parameters;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers })).status, 405);
    const empty = await (await fetch(url, { headers })).json() as AnalyticsData;
    assert.equal(empty.summary.currentKw, null);
    assert.equal(empty.summary.energyKWh, 0);
    const store = createPrismaPulseStore(client);
    const pulse = (sequence: number, time: number) => processPulse(store, { deviceId: hardwareId, sequence, pulse: 1, timestamp: new Date(time).toISOString() }, token);
    await pulse(2, now - 3600); await pulse(1, now - 7200); await pulse(2, now - 3600);
    const load = async () => {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      return response.json() as Promise<AnalyticsData>;
    };
    const data = await load();
    assert.equal(data.summary.energyKWh, .002);
    assert.equal(data.summary.currentKw, 1);
    assert.equal(data.summary.peakIntervalKw, 1);
    assert.equal(data.summary.averageKw, null);
    assert.equal(data.summary.online, true);
    assert.equal(data.pulseDetails.pulses.length, 2);
    assert.equal(data.pulseDetails.pulses[0].intervalSeconds, 3.6);
    assert.equal(data.buckets.reduce((n, b) => n + b.pulseCount, 0), 2);
    assert.deepEqual((await load()).buckets, data.buckets); // Repeated live snapshots cannot double-count.
    await pulse(3, now - 2400);
    const live = await load();
    assert.equal(live.summary.currentKw, 3);
    assert.equal(live.summary.energyKWh, .003);
    parameters.set("resolution", "minutes");
    const coarse = await (await fetch(origin + "/?" + parameters, { headers })).json() as AnalyticsData;
    assert.equal(coarse.summary.energyKWh, live.summary.energyKWh);
    parameters.set("start", new Date(now - 86400000).toISOString()); parameters.set("resolution", "seconds");
    assert.equal((await fetch(origin + "/?" + parameters, { headers })).status, 400);
    await pulse(4, now - 3600); await pulse(5, now - 2400); // Clock rollback repeats an observed interval.
    const rollback = await load();
    assert.equal(rollback.summary.currentKw, null);
    assert.equal(rollback.summary.energyKWh, .005);
    await client.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(now - 120000) } });
    const offline = await load();
    assert.equal(offline.summary.online, false);
    assert.equal(offline.summary.currentKw, null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await client.pulseEvent.deleteMany({ where: { deviceId: device.id } });
    await client.meterState.deleteMany({ where: { deviceId: device.id } });
    await client.device.delete({ where: { id: device.id } });
    await client.$disconnect();
    if (oldUser === undefined) delete process.env.DASHBOARD_USERNAME; else process.env.DASHBOARD_USERNAME = oldUser;
    if (oldPass === undefined) delete process.env.DASHBOARD_PASSWORD; else process.env.DASHBOARD_PASSWORD = oldPass;
  }
});
