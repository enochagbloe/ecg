import assert from "node:assert/strict";
import { test } from "node:test";
import type { Device } from "@prisma/client";
import { bootstrapEnvironmentSchema, deviceProvisioningSchema, provisionBootstrapDevice, type BootstrapDeviceStore } from "../server/services/deviceProvisioningService";
import { meterConstantSchema } from "../server/services/meterConstant";
import { energyFromPulses, powerFromInterval } from "../server/services/calculationService";
import { hashSecret } from "../server/services/deviceAuthService";

const input = { hardwareId: "ECG-test", secret: "test-only-secret-with-at-least-32-characters", meterConstant: 800 };
const env = { BOOTSTRAP_DEVICE_ID: input.hardwareId, BOOTSTRAP_DEVICE_SECRET: input.secret, BOOTSTRAP_METER_CONSTANT: "800" };

test("shared calibration validator rejects invalid values in provisioning and calculations", () => {
  for (const value of [0, -800, 1.5, NaN, Infinity, 100001, "1600", null, undefined]) {
    assert.equal(meterConstantSchema.safeParse(value).success, false);
    assert.equal(deviceProvisioningSchema.safeParse({ ...input, meterConstant: value }).success, false);
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, 100001]) {
    assert.throws(() => energyFromPulses(1n, value));
    assert.throws(() => powerFromInterval(1000, value));
  }
  for (const value of [1, 800, 1000, 1600, 3200, 100000]) {
    assert.equal(meterConstantSchema.parse(value), value);
  }
});

test("bootstrap environment requires explicit valid calibration with no fallback", () => {
  assert.deepEqual(bootstrapEnvironmentSchema.parse(env), input);
  for (const value of [undefined, "", " ", "0", "-1", "1.5", "NaN", "Infinity", "100001", "1600oops"]) {
    assert.equal(bootstrapEnvironmentSchema.safeParse({ ...env, BOOTSTRAP_METER_CONSTANT: value }).success, false);
  }
  for (const key of Object.keys(env)) {
    assert.equal(bootstrapEnvironmentSchema.safeParse({ ...env, [key]: undefined }).success, false);
  }
});

test("provisioning stores explicit calibration; reseeding rotates only credentials", async () => {
  let saved: Device | null = null;
  let createdState = false;
  const store: BootstrapDeviceStore = {
    async upsert(write) {
      if (saved) {
        // Apply all supplied update fields, so an accidental calibration update fails this test.
        saved = { ...saved, ...write.update };
      } else {
        assert.ok(write.create.meterState?.create);
        createdState = true;
        saved = {
          id: "test-id", hardwareId: write.create.hardwareId, apiKeyHash: write.create.apiKeyHash,
          meterConstant: write.create.meterConstant, name: null, firmwareVersion: null,
          isActive: true, lastSeenAt: null, createdAt: new Date(), updatedAt: new Date(),
        };
      }
      return saved;
    },
  };
  const created = await provisionBootstrapDevice(store, input);
  assert.equal(created.meterConstant, 800);
  assert.equal(created.apiKeyHash, hashSecret(input.secret));
  assert.equal(createdState, true);
  const rotatedSecret = input.secret + "-rotated";
  const reseeded = await provisionBootstrapDevice(store, { ...input, secret: rotatedSecret, meterConstant: 3200 });
  assert.equal(reseeded.meterConstant, 800);
  assert.equal(reseeded.id, created.id);
  assert.equal(reseeded.apiKeyHash, hashSecret(rotatedSecret));
});

test("invalid provisioning fails before a database write", async () => {
  const store: BootstrapDeviceStore = { async upsert() { assert.fail("Database must not be called"); } };
  await assert.rejects(provisionBootstrapDevice(store, { ...input, meterConstant: 0 }));
});