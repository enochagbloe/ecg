import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import logger from "../../libs/logger";
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
    // Prototype bench testing: write a bounded, safe telemetry summary so
    // readings can be inspected remotely in Render Logs without browser access.
    // Never log the Authorization header, device token, or Wi-Fi credentials.
    logger.info({
      deviceId: entry.deviceId,
      receivedAt: entry.receivedAt,
      diagnosticOnly: entry.diagnosticOnly,
      adcMin: entry.minimum,
      adcMax: entry.maximum,
      baseline: entry.baseline,
      peakDelta: entry.peakDelta,
      onDelta: entry.onDelta,
      offDelta: entry.offDelta,
      samples: entry.samples,
      candidates: entry.candidates,
      detected: entry.detected,
      shortRejected: entry.shortRejected,
      longRejected: entry.longRejected,
      saturatedSamples: entry.saturatedSamples,
      queueDrops: entry.queueDrops,
      armed: entry.armed,
    }, "TEPT4400 optical diagnostic received");
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
