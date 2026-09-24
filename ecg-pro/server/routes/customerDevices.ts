import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../libs/prisma";
import { emptyState, serializeState } from "../services/calculationService";
import { authorizeCustomer } from "../services/customerAuthService";
import { meterConstantSchema } from "../services/meterConstant";
import { HttpError, json, readJson } from "../utils/http";

const deviceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

// Prototype flow: first authenticated customer may claim an unowned,
// already-provisioned hardware ID. No claim code is required.
const claimSchema = z.object({
  deviceId: deviceIdSchema,
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  meterConstant: meterConstantSchema.optional(),
}).strict().refine(
  (value) => value.name !== undefined || value.meterConstant !== undefined,
);

function serializeDevice(device: {
  hardwareId: string;
  name: string | null;
  isActive: boolean;
  lastSeenAt: Date | null;
  meterConstant: number;
  meterState: {
    totalPulses: bigint;
    lastSequence: bigint | null;
    lastPulseAt: Date | null;
    lastIntervalMs: bigint | null;
    powerKw: number;
  } | null;
}) {
  return {
    deviceId: device.hardwareId,
    name: device.name,
    online:
      device.isActive &&
      device.lastSeenAt !== null &&
      Date.now() - device.lastSeenAt.getTime() < 90_000,
    ...serializeState(device.meterState ?? emptyState(), device.meterConstant),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    meterConstant: device.meterConstant,
  };
}

async function ownedDevice(userId: string, hardwareId: string) {
  const ownership = await prisma.deviceOwnership.findFirst({
    where: { userId, device: { hardwareId } },
    include: { device: { include: { meterState: true } } },
  });

  if (!ownership) throw new HttpError(404, "Device not found");
  return ownership;
}

export async function customerClaimDevice(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const parsed = claimSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, "Expected deviceId");

  const device = await prisma.device.findUnique({
    where: { hardwareId: parsed.data.deviceId },
    include: { ownership: true, meterState: true },
  });

  if (!device) throw new HttpError(404, "Device not found");

  if (device.ownership) {
    if (device.ownership.userId !== auth.user.id) {
      throw new HttpError(409, "Device is already claimed");
    }

    json(res, 200, serializeDevice(device));
    return;
  }

  try {
    await prisma.deviceOwnership.create({
      data: { userId: auth.user.id, deviceId: device.id },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new HttpError(409, "Device is already claimed");
    }
    throw error;
  }

  json(res, 201, serializeDevice(device));
}

export async function customerListDevices(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const rows = await prisma.deviceOwnership.findMany({
    where: { userId: auth.user.id },
    orderBy: { createdAt: "asc" },
    include: { device: { include: { meterState: true } } },
  });

  json(res, 200, {
    devices: rows.map((row) => serializeDevice(row.device)),
  });
}

export async function customerDeviceState(
  req: IncomingMessage,
  res: ServerResponse,
  hardwareId: string,
) {
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const ownership = await ownedDevice(auth.user.id, hardwareId);
  json(res, 200, serializeDevice(ownership.device));
}

export async function customerUpdateDevice(
  req: IncomingMessage,
  res: ServerResponse,
  hardwareId: string,
) {
  if (req.method !== "PATCH") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const ownership = await ownedDevice(auth.user.id, hardwareId);
  const parsed = updateSchema.safeParse(await readJson(req));

  if (!parsed.success) {
    throw new HttpError(400, "Expected name and/or meterConstant");
  }

  const device = await prisma.device.update({
    where: { id: ownership.device.id },
    data: parsed.data,
    include: { meterState: true },
  });

  json(res, 200, serializeDevice(device));
}

export async function customerRemoveDevice(
  req: IncomingMessage,
  res: ServerResponse,
  hardwareId: string,
) {
  if (req.method !== "DELETE") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const ownership = await ownedDevice(auth.user.id, hardwareId);
  await prisma.deviceOwnership.delete({ where: { id: ownership.id } });

  json(res, 200, { ok: true });
}
