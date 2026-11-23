import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMeterSettingsHandler } from "../server/routes/meterSettings";
import { HttpError, json } from "../server/utils/http";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import {
  createMeterSettingsService,
  settingsChange,
  canActivate,
} from "../server/services/meterSettingsService";
import { hashSecret } from "../server/services/deviceAuthService";
import {
  queryAnalytics,
  queryPulseDetails,
} from "../server/services/analyticsService";
import { analyticsQuery } from "../server/services/analyticsPolicy";
import {
  applyPulse,
  emptyState,
  serializeState,
} from "../server/services/calculationService";
const token = "settings-test-credential-with-at-least-32-characters";
const a = "a".repeat(32),
  b = "b".repeat(32),
  c = "c".repeat(32);
class Store {
  device = {
    id: "d",
    hardwareId: "TEST",
    meterConstant: 1000,
    apiKeyHash: hashSecret(token),
    isActive: true,
    name: null,
  };
  settings: any = null;
  periods: any[] = [
    { startSequence: 0n, meterConstant: 1000, label: "Original" },
  ];
  boots = new Map<string, any>();
  state: any = {
    totalPulses: 20n,
    lastSequence: 20n,
    energyKWh: 0.02,
    powerKw: 2,
    lastIntervalMs: 1800n,
  };
  queue = Promise.resolve();
  get tx() {
    return {
      $queryRaw: async () => [this.device],
      device: {
        findUnique: async () => this.device,
        update: async ({ data }: any) => (
          Object.assign(this.device, data),
          this.device
        ),
      },
      deviceSettings: {
        findUnique: async () => this.settings,
        update: async ({ data }: any) => (
          Object.assign(this.settings, data),
          this.settings
        ),
        upsert: async ({ create, update }: any) =>
          (this.settings = this.settings
            ? Object.assign(this.settings, update)
            : create),
      },
      deviceBoot: {
        findUnique: async ({ where }: any) =>
          this.boots.get(where.deviceId_bootId.bootId) ?? null,
        create: async ({ data }: any) => {
          this.boots.set(data.bootId, data);
          return data;
        },
      },
      meterPeriod: {
        findFirst: async () => this.periods.at(-1),
        count: async () => this.periods.length,
        create: async ({ data }: any) => {
          this.periods.push(data);
          return data;
        },
      },
      meterState: {
        findUnique: async () => this.state,
        update: async ({ data }: any) => Object.assign(this.state, data),
      },
    };
  }
  get client() {
    return {
      ...this.tx,
      $transaction: <T>(work: (tx: unknown) => Promise<T>) => {
        const run = this.queue.then(async () => {
          const snapshot = structuredClone({
            device: this.device,
            settings: this.settings,
            periods: this.periods,
            boots: this.boots,
            state: this.state,
          });
          try {
            return await work(this.tx);
          } catch (e) {
            Object.assign(this, snapshot);
            throw e;
          }
        });
        this.queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    } as unknown as PrismaClient;
  }
}
const report = (
  bootId: string,
  resetRequestId: string | null = null,
  bootHead = 20,
) => ({
  deviceId: "TEST",
  bootId,
  bootHead,
  resetRequestId,
  firmwareVersion: "s3-settings-v1",
});
const request = {
  action: "request",
  meterConstant: 1005,
  label: "Replacement meter",
  confirm: true,
};
test("meter settings: authenticates device, stages change, requires durable challenge and a new boot; retry is idempotent", async () => {
  const s = new Store(),
    api = createMeterSettingsService(s.client);
  await assert.rejects(api.change("TEST", request), /reset-aware/);
  await assert.rejects(api.report(report(a), "wrong"), /credentials/);
  assert.equal(JSON.stringify(s.settings), "null");
  await api.report(report(a), token);
  await api.change("TEST", request);
  const id = s.settings.requestId;
  assert.equal(s.device.meterConstant, 1000);
  assert.equal(s.periods.length, 1);
  await api.report(report(a), token);
  assert.equal(s.settings.armedAt, null);
  await assert.rejects(api.report(report(b), token), /boundary/);
  assert.equal(s.settings.bootId, a);
  await api.report(report(a, id), token);
  assert.ok(s.settings.armedAt);
  await api.report(report(a, id), token);
  assert.equal(s.device.meterConstant, 1000);
  await api.report(report(b, id), token);
  assert.equal(s.device.meterConstant, 1005);
  assert.equal(s.periods.length, 2);
  assert.equal(s.periods[1].startSequence, 21n);
  assert.equal(s.state.totalPulses, 20n);
  assert.equal(s.state.lastSequence, 20n);
  assert.equal(s.state.energyKWh, 0.02);
  assert.equal(s.state.powerKw, 0);
  await api.report(report(b, id), token);
  assert.equal(s.periods.length, 2);
  await assert.rejects(api.report(report(a, id), token), /Stale/);
  await assert.rejects(api.report(report(b, id, 21), token), /changed/);
});
test("meter settings: cancellation, conflicting requests, immutable boundary and firmware support", async () => {
  const s = new Store(),
    api = createMeterSettingsService(s.client);
  await api.report(report(a), token);
  const results = await Promise.allSettled([
    api.change("TEST", request),
    api.change("TEST", request),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const id = s.settings.requestId;
  await api.change("TEST", { action: "cancel", requestId: id });
  await assert.rejects(
    api.change("TEST", { action: "cancel", requestId: id }),
    /no longer/,
  );
  await api.report(report(b, id), token);
  assert.equal(s.device.meterConstant, 1000);
  assert.equal(
    canActivate(
      {
        bootId: a,
        expectedBootId: a,
        requestedAt: new Date(),
        bootFirstSeenAt: new Date(),
      },
      { bootId: c, bootHead: 19 },
      20n,
      0n,
    ),
    false,
  );
  for (const v of [0, -1, 1.5, 100001])
    assert.equal(
      settingsChange.safeParse({ ...request, meterConstant: v }).success,
      false,
    );
  for (const v of [1000, 1005, 1006])
    assert.equal(
      settingsChange.safeParse({ ...request, meterConstant: v }).success,
      true,
    );
  assert.equal(
    settingsChange.safeParse({ ...request, confirm: false }).success,
    false,
  );
});
test("energy ledger preserves old calibration and includes replay using its original constant", () => {
  let s = applyPulse(emptyState(), 1n, new Date(1000), 1000, false);
  s = applyPulse(s, 3n, new Date(3000), 1005, false);
  s = applyPulse(s, 2n, new Date(2000), 1000, false);
  assert.ok(
    Math.abs(serializeState(s, 1005).energyKWh - (2 / 1000 + 1 / 1005)) < 1e-12,
  );
  assert.equal(s.lastSequence, 3n);
  assert.equal(s.totalPulses, 3n);
});
test("PostgreSQL migration preserves customer ownership, usage and mixed-meter analytics", async () => {
  const db = new PGlite();
  try {
    const dirs = readdirSync("prisma/migrations")
      .filter((n) => n.startsWith("20"))
      .sort();
    for (const d of dirs.filter((n) => !n.includes("meter_settings")))
      await db.exec(
        readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"),
      );
    await db.exec(`INSERT INTO "Device" (id,"hardwareId","apiKeyHash","meterConstant","updatedAt") VALUES ('d','TEST','${"a".repeat(64)}',1000,now());
 INSERT INTO "CustomerUser" (id,"fullName",email,"passwordHash","updatedAt") VALUES ('u','Test','test@example.invalid','test-only',now());
 INSERT INTO "DeviceOwnership" (id,"userId","deviceId") VALUES ('o','u','d');
 INSERT INTO "MeterState" ("deviceId","totalPulses","lastSequence","updatedAt") VALUES ('d',2,2,now());
 INSERT INTO "PulseEvent" (id,"deviceId",sequence,"occurredAt","receivedAt") VALUES ('p1','d',1,'2026-11-01T12:00:00Z','2026-11-01T12:00:00Z'),('p2','d',2,'2026-11-01T12:00:01Z','2026-11-01T12:00:01Z');`);
    await db.exec(
      readFileSync(
        "prisma/migrations/20261123000000_meter_settings/migration.sql",
        "utf8",
      ),
    );
    const state = (
      await db.query<{ energyKWh: number }>(
        'SELECT "energyKWh" FROM "MeterState"',
      )
    ).rows[0];
    assert.equal(state.energyKWh, 0.002);
    assert.equal(
      (await db.query('SELECT * FROM "DeviceOwnership"')).rows.length,
      1,
    );
    assert.equal(
      (await db.query('SELECT * FROM "CustomerUser"')).rows.length,
      1,
    );
    await db.exec(`INSERT INTO "MeterPeriod" (id,"deviceId","startSequence","meterConstant",label,"confirmedBootId") VALUES ('new','d',3,1005,'New','${b}');UPDATE "Device" SET "meterConstant"=1005 WHERE id='d';
 INSERT INTO "PulseEvent" (id,"deviceId",sequence,"occurredAt","receivedAt") VALUES ('p3','d',3,'2026-11-01T12:00:02Z','2026-11-01T12:00:02Z'),('p4','d',4,'2026-11-01T12:00:03Z','2026-11-01T12:00:03Z');`);
    const client = {
      $queryRaw: async (sql: Prisma.Sql) =>
        (await db.query(sql.text, sql.values)).rows,
    } as unknown as Pick<PrismaClient, "$queryRaw">;
    const q = analyticsQuery(
      new URLSearchParams({
        start: "2026-11-01T12:00:00Z",
        end: "2026-11-01T12:00:04Z",
        resolution: "seconds",
        timezone: "Africa/Accra",
      }),
    );
    const rows = await queryAnalytics(client, "d", 1005, q);
    assert.ok(
      Math.abs(
        rows.reduce((n, r) => n + r.energyKWh, 0) - (2 / 1000 + 2 / 1005),
      ) < 1e-12,
    );
    // Old ingestion omits energyKWh when updating state. The INSERT trigger
    // must preserve its already-committed energy even during rolling cutover.
    await db.exec(`UPDATE "MeterState" SET "totalPulses"=4,"lastSequence"=4 WHERE "deviceId"='d';`);
    const ledger=async()=>Number((await db.query<{energyKWh:number}>(`SELECT "energyKWh" FROM "MeterState" WHERE "deviceId"='d'`)).rows[0].energyKWh);
    assert.ok(Math.abs(await ledger()-(2/1000+2/1005))<1e-12);
    await db.exec(`INSERT INTO "PulseEvent" (id,"deviceId",sequence,"occurredAt") VALUES ('retry','d',4,now()) ON CONFLICT DO NOTHING;`);
    assert.ok(Math.abs(await ledger()-(2/1000+2/1005))<1e-12);
    await db.exec(`BEGIN; INSERT INTO "PulseEvent" (id,"deviceId",sequence,"occurredAt") VALUES ('rollback','d',5,now()); ROLLBACK;`);
    assert.ok(Math.abs(await ledger()-(2/1000+2/1005))<1e-12);
    await assert.rejects(db.exec(`UPDATE "Device" SET "meterConstant"=1006 WHERE id='d'`),/reset-confirmed/);
    await db.exec(`INSERT INTO "Device" (id,"hardwareId","apiKeyHash","meterConstant","updatedAt") VALUES ('fresh','FRESH','${"a".repeat(64)}',1000,now());
      INSERT INTO "PulseEvent" (id,"deviceId",sequence,"occurredAt") VALUES ('first','fresh',1,now());
      INSERT INTO "MeterState" ("deviceId","totalPulses","lastSequence","updatedAt") VALUES ('fresh',1,1,now());`);
    assert.equal(Number((await db.query<{energyKWh:number}>(`SELECT "energyKWh" FROM "MeterState" WHERE "deviceId"='fresh'`)).rows[0].energyKWh),.001);
    const details = await queryPulseDetails(client, "d", 1005, q);
    assert.equal(
      details.pulses.find((p) => p.sequence === "3")!.intervalSeconds,
      null,
    );
    assert.equal(
      details.pulses.find((p) => p.sequence === "2")!.energyKWh,
      0.001,
    );
    assert.equal(
      details.pulses.find((p) => p.sequence === "4")!.energyKWh,
      1 / 1005,
    );
  } finally {
    await db.close();
  }
});

test("settings HTTP: dashboard authentication, customer ownership, same-origin mutations and method validation", async () => {
  const s = new Store();
  let ownershipChecks = 0;
  const client = {
    ...s.client,
    deviceOwnership: {
      findFirst: async () => {
        ownershipChecks++;
        return null;
      },
    },
  } as unknown as PrismaClient;
  const customer = createMeterSettingsHandler(
    client,
    async () => ({ user: { id: "other-account" } }) as never,
  );
  const dashboard = createMeterSettingsHandler(client);
  const oldUser = process.env.DASHBOARD_USERNAME,
    oldPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_USERNAME = "settings-test";
  process.env.DASHBOARD_PASSWORD =
    "settings-test-password-at-least-32-characters";
  const server = createServer((req, res) => {
    void (
      req.url === "/customer"
        ? customer(req, res, "TEST", true)
        : dashboard(req, res, "TEST")
    ).catch((e) =>
      json(res, e instanceof HttpError ? e.status : 500, { error: e.message }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(
        `${process.env.DASHBOARD_USERNAME}:${process.env.DASHBOARD_PASSWORD}`,
      ).toString("base64"),
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { Authorization: "Bearer " + token } }))
        .status,
      401,
    );
    assert.equal((await fetch(url + "/customer")).status, 404);
    assert.equal(ownershipChecks, 1);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
          body: JSON.stringify({ action: "rename", name: "Wrong" }),
        })
      ).status,
      403,
    );
    assert.equal(s.device.name, null);
    assert.equal((await fetch(url, { method: "DELETE", headers })).status, 405);
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "rename", name: "Main building" }),
        })
      ).status,
      200,
    );
    assert.equal(s.device.name, "Main building");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldUser === undefined) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = oldUser;
    if (oldPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = oldPassword;
  }
});

test("successive reset-confirmed meter changes without new pulses retain both history entries",async()=>{
 const s=new Store(),api=createMeterSettingsService(s.client);await api.report(report(a),token);
 await api.change("TEST",request);let id=s.settings.requestId;
 await api.report(report(a,id),token);await api.report(report(b,id),token);
 await api.change("TEST",{...request,meterConstant:1006});id=s.settings.requestId;
 await api.report(report(b,id),token);await api.report(report(c,id),token);
 assert.equal(s.periods.length,3);assert.equal(s.periods[1].startSequence,21n);assert.equal(s.periods[2].startSequence,21n);
 assert.equal(s.device.meterConstant,1006);assert.equal(s.state.totalPulses,20n);assert.equal(s.state.energyKWh,.02);
});
