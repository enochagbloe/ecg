import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { emptyState, serializeState } from "../services/calculationService";
import { authorizeViewer } from "../services/viewerAuthService";
import { HttpError, json } from "../utils/http";

export async function deviceState(req: IncomingMessage, res: ServerResponse, hardwareId: string) {
  authorizeViewer(req, res);
  const device = await prisma.device.findUnique({ where: { hardwareId }, include: { meterState: true } });
  if (!device) throw new HttpError(404, "Device not found");
  json(res, 200, {
    deviceId: device.hardwareId,
    online: device.isActive && device.lastSeenAt !== null && Date.now() - device.lastSeenAt.getTime() < 90_000,
    ...serializeState(device.meterState ?? emptyState(), device.meterConstant),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    meterConstant: device.meterConstant,
  });
}