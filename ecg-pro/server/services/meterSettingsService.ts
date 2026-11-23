import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { meterConstantSchema } from "./meterConstant";
import { authenticateDevice } from "./deviceAuthService";
import { HttpError } from "../utils/http";

export const settingsChange = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("rename"),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("request"),
      meterConstant: meterConstantSchema,
      label: z.string().trim().min(1).max(120),
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({ action: z.literal("cancel"), requestId: z.string().uuid() })
    .strict(),
]);
export const bootReport = z
  .object({
    deviceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    bootId: z.string().regex(/^[a-f0-9]{32}$/),
    bootHead: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    resetRequestId: z.string().uuid().nullable(),
    firmwareVersion: z.literal("s3-settings-v1"),
  })
  .strict();
// A restart creates a new boundary AFTER every durable pre-boot pulse.
export function canActivate(
  s: {
    bootId: string | null;
    bootFirstSeenAt: Date | null;
    requestedAt: Date | null;
    expectedBootId: string | null;
  },
  b: { bootId: string; bootHead: number },
  serverHead: bigint,
  latestBoundary: bigint,
) {
  return (
    !!s.requestedAt &&
    b.bootId !== s.expectedBootId &&
    b.bootId !== s.bootId &&
    BigInt(b.bootHead) >= serverHead &&
    BigInt(b.bootHead) + 1n >= latestBoundary
  );
}
export function createMeterSettingsService(client: PrismaClient) {
  const locked = <T>(
    hardwareId: string,
    work: (
      tx: Prisma.TransactionClient,
      d: { id: string; hardwareId: string; meterConstant: number },
    ) => Promise<T>,
  ) =>
    client.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; hardwareId: string; meterConstant: number }[]
        >(
          Prisma.sql`SELECT * FROM "Device" WHERE "hardwareId"=${hardwareId} FOR UPDATE`,
        );
        if (!rows[0]) throw new HttpError(404, "Device not found");
        return work(tx, rows[0]);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  return {
    async read(hardwareId: string) {
      const d = await client.device.findUnique({
        where: { hardwareId },
        include: {
          settings: true,
          meterPeriods: { orderBy: [{ startSequence: "desc" }, { revision: "desc" }] },
          meterState: true,
        },
      });
      if (!d) throw new HttpError(404, "Device not found");
      return {
        deviceId: d.hardwareId,
        name: d.name,
        active: d.isActive,
        online:
          d.isActive &&
          !!d.lastSeenAt &&
          Date.now() - d.lastSeenAt.getTime() < 90000,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        firmwareVersion: d.settings?.firmwareVersion ?? d.firmwareVersion,
        resetSupported: d.settings?.firmwareVersion === "s3-settings-v1",
        meterConstant: d.meterConstant,
        totalPulses: Number(d.meterState?.totalPulses ?? 0n),
        pending: d.settings?.pendingConstant
          ? {
              requestId: d.settings.requestId,
              meterConstant: d.settings.pendingConstant,
              label: d.settings.pendingLabel,
              requestedAt: d.settings.requestedAt?.toISOString(),
              resetReady: !!d.settings.armedAt,
            }
          : null,
        history: d.meterPeriods.map((p) => ({
          id: p.id,
          label: p.label,
          meterConstant: p.meterConstant,
          startSequence: p.startSequence.toString(),
          effectiveAt: p.effectiveAt.toISOString(),
          resetConfirmed: !!p.confirmedBootId,
        })),
      };
    },
    async change(hardwareId: string, input: unknown) {
      const parsed = settingsChange.safeParse(input);
      if (!parsed.success) throw new HttpError(400, "Invalid settings request");
      const v = parsed.data;
      return locked(hardwareId, async (tx, d) => {
        if (v.action === "rename") {
          await tx.device.update({
            where: { id: d.id },
            data: { name: v.name },
          });
          return { ok: true };
        }
        const s = await tx.deviceSettings.findUnique({
          where: { deviceId: d.id },
        });
        if (v.action === "cancel") {
          if (s?.requestId !== v.requestId || !s.pendingConstant)
            throw new HttpError(409, "Meter change is no longer pending");
          await tx.deviceSettings.update({
            where: { deviceId: d.id },
            data: {
              pendingConstant: null,
              pendingLabel: null,
              requestedAt: null,
              requestId: null,
              expectedBootId: null,
              armedAt: null,
            },
          });
          return { ok: true };
        }
        if (!s?.bootId || s.firmwareVersion !== "s3-settings-v1")
          throw new HttpError(
            409,
            "Install reset-aware firmware and let it connect before changing the meter",
          );
        if (s.pendingConstant)
          throw new HttpError(409, "A meter change is already pending");
        if (!(await tx.meterPeriod.count({ where: { deviceId: d.id } })))
          await tx.meterPeriod.create({
            data: {
              deviceId: d.id,
              startSequence: 0n,
              meterConstant: d.meterConstant,
              label: "Original configuration",
            },
          });
        await tx.deviceSettings.update({
          where: { deviceId: d.id },
          data: {
            pendingConstant: v.meterConstant,
            pendingLabel: v.label,
            requestedAt: new Date(),
            armedAt: null,
            expectedBootId: s.bootId,
            requestId: randomUUID(),
          },
        });
        return { ok: true, pending: true };
      });
    },
    async report(input: unknown, token: string) {
      const parsed = bootReport.safeParse(input);
      if (!parsed.success) throw new HttpError(400, "Invalid boot report");
      const b = parsed.data;
      return locked(b.deviceId, async (tx, d) => {
        authenticateDevice(
          await tx.device.findUnique({ where: { id: d.id } }),
          token,
        );
        const s = await tx.deviceSettings.findUnique({
          where: { deviceId: d.id },
        });
        const latest = await tx.meterPeriod.findFirst({
          where: { deviceId: d.id },
          orderBy: [{ startSequence: "desc" }, { revision: "desc" }],
        });
        const state = await tx.meterState.findUnique({
          where: { deviceId: d.id },
        });
        const known = await tx.deviceBoot.findUnique({
          where: { deviceId_bootId: { deviceId: d.id, bootId: b.bootId } },
        });
        if (
          known &&
          (known.bootHead !== BigInt(b.bootHead) || s?.bootId !== b.bootId)
        )
          throw new HttpError(
            409,
            "Stale boot identity or changed restart boundary",
          );
        // Idempotent repeated reports from this boot can never create another period.
        if (
          s?.pendingConstant &&
          s.armedAt &&
          b.resetRequestId === s.requestId &&
          !known &&
          canActivate(
            s,
            b,
            state?.lastSequence ?? 0n,
            latest?.startSequence ?? 0n,
          )
        ) {
          await tx.meterPeriod.create({
            data: {
              deviceId: d.id,
              startSequence: BigInt(b.bootHead) + 1n,
              meterConstant: s.pendingConstant,
              label: s.pendingLabel!,
              confirmedBootId: b.bootId,
            },
          });
          await tx.device.update({
            where: { id: d.id },
            data: { meterConstant: s.pendingConstant },
          });
          if (state)
            await tx.meterState.update({
              where: { deviceId: d.id },
              data: { powerKw: 0, lastIntervalMs: null },
            });
          await tx.deviceSettings.update({
            where: { deviceId: d.id },
            data: {
              pendingConstant: null,
              pendingLabel: null,
              requestedAt: null,
              expectedBootId: null,
              armedAt: null,
              completedRequestId: s.requestId,
              requestId: null,
            },
          });
        } else if (
          s?.pendingConstant &&
          b.bootId !== s.bootId &&
          b.bootId !== s.expectedBootId
        ) {
          throw new HttpError(
            409,
            "Restart boundary conflicts with stored measurements; meter change retained",
          );
        }
        if (
          s?.pendingConstant &&
          b.bootId === s.expectedBootId &&
          b.resetRequestId === s.requestId &&
          !s.armedAt
        )
          await tx.deviceSettings.update({
            where: { deviceId: d.id },
            data: { armedAt: new Date() },
          });
        if (!known)
          await tx.deviceBoot.create({
            data: {
              deviceId: d.id,
              bootId: b.bootId,
              bootHead: BigInt(b.bootHead),
            },
          });
        const data = {
          bootId: b.bootId,
          bootHead: BigInt(b.bootHead),
          firmwareVersion: b.firmwareVersion,
          ...(s?.bootId !== b.bootId ? { bootFirstSeenAt: new Date() } : {}),
        };
        await tx.deviceSettings.upsert({
          where: { deviceId: d.id },
          create: { deviceId: d.id, ...data },
          update: data,
        });
        return {
          ok: true,
          bootAccepted: true,
          deviceId: b.deviceId,
          bootId: b.bootId,
          armRequestId:
            s?.pendingConstant && b.bootId === s.expectedBootId
              ? s.requestId
              : null,
        };
      });
    },
  };
}
