import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createPrismaPulseStore } from "../server/services/prismaPulseStore";
import { processPulse } from "../server/services/pulseService";
import { hashSecret } from "../server/services/deviceAuthService";

// Explicitly opt in using a migrated test database. Never fall back to DATABASE_URL.
test("PostgreSQL: concurrent retries and unique events remain consistent across clients", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const options = { datasources: { db: { url: process.env.TEST_DATABASE_URL! } } };
  const clients = [new PrismaClient(options), new PrismaClient(options)];
  const hardwareId = "test-" + randomBytes(12).toString("hex");
  const token = randomBytes(32).toString("hex");
  const device = await clients[0].device.create({ data: { hardwareId, apiKeyHash: hashSecret(token), meterConstant: 1600 } });
  try {
    const stores = clients.map(createPrismaPulseStore);
    const input = { deviceId: hardwareId, pulse: 1 as const, sequence: 1, timestamp: "2026-09-19T08:00:00.000Z" };
    const retries = await Promise.all(Array.from({ length: 12 }, (_, i) => processPulse(stores[i % 2], input, token)));
    assert.equal(retries.filter((r) => "duplicate" in r && !r.duplicate).length, 1);
    await Promise.all(Array.from({ length: 12 }, (_, i) => processPulse(stores[i % 2], {
      ...input, sequence: i + 2, timestamp: new Date(Date.parse(input.timestamp) + (i + 1) * 1000).toISOString(),
    }, token)));
    assert.equal(await clients[0].pulseEvent.count({ where: { deviceId: device.id } }), 13);
    const state = await clients[1].meterState.findUniqueOrThrow({ where: { deviceId: device.id } });
    assert.equal(state.totalPulses, 13n);
    assert.equal(state.lastSequence, 13n);
    await processPulse(stores[0], { ...input, pulse: 0 }, token);
    assert.equal(await clients[0].pulseEvent.count({ where: { deviceId: device.id } }), 13);
  } finally {
    await clients[0].pulseEvent.deleteMany({ where: { deviceId: device.id } });
    await clients[0].meterState.deleteMany({ where: { deviceId: device.id } });
    await clients[0].device.delete({ where: { id: device.id } });
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});