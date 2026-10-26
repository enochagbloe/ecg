import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { bearerToken, authenticateDevice } from "../services/deviceAuthService";
import { opticalDiagnosticSchema, appendOpticalDiagnostic, recentOpticalDiagnostics } from "../services/opticalDiagnosticService";
import { authorizeViewer } from "../services/viewerAuthService";
import { getIO } from "../socketServer";
import { HttpError, json, readJson } from "../utils/http";

// Diagnostics are independent of meter pulses, stored totals and sequence ACKs.
export async function receiveOpticalDiagnostic(req: IncomingMessage, res: ServerResponse) {
  const raw = await readJson(req);
  const parsed = opticalDiagnosticSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid optical diagnostic payload");
  const { deviceId } = parsed.data;
  const device = await prisma.device.findUnique({ where: { hardwareId: deviceId } });
  authenticateDevice(device, bearerToken(req.headers.authorization));

  const entry = appendOpticalDiagnostic(parsed.data);
  if (entry) {
    const io = getIO();
    io.to("dashboard").emit("opticalDiagnostic", entry);
    io.to(`device:${deviceId}`).emit("opticalDiagnostic", entry);
  }
  json(res, 200, { ok: true, accepted: Boolean(entry) });
}

export async function listOpticalDiagnostics(req: IncomingMessage, res: ServerResponse, hardwareId: string) {
  authorizeViewer(req, res);
  const device = await prisma.device.findUnique({ where: { hardwareId }, select: { id: true } });
  if (!device) throw new HttpError(404, "Device not found");
  json(res, 200, { deviceId: hardwareId, logs: recentOpticalDiagnostics(hardwareId) });
}
