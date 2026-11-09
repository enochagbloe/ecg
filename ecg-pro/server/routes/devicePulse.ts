import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { bearerToken } from "../services/deviceAuthService";
import { createPrismaPulseStore } from "../services/prismaPulseStore";
import { processPulse, processPulseBatch, pulseBatchSchema, pulseBroadcast, pulseSchema } from "../services/pulseService";
import { getIO } from "../socketServer";
import { HttpError, json, readJson } from "../utils/http";

const store = createPrismaPulseStore(prisma);

export async function devicePulse(req: IncomingMessage, res: ServerResponse) {
  const token = bearerToken(req.headers.authorization);
  const body = await readJson(req);
  if (body && typeof body === "object" && "events" in body) {
    const batch = pulseBatchSchema.safeParse(body);
    if (!batch.success) throw new HttpError(400, "Expected deviceId and 1–50 ordered, contiguous pulse events");
    const result = await processPulseBatch(store, batch.data, token);
    if (result.inserted) {
      const event = { deviceId: result.deviceId, pulseCount: result.state.totalPulses,
        timestamp: result.state.lastPulseAt, energyKWh: result.state.energyKWh, powerKw: result.state.powerKw };
      getIO().to("dashboard").emit("pulseData", event);
      getIO().to(`device:${event.deviceId}`).emit("pulseData", event);
    }
    json(res, 200, result);
    return;
  }
  const parsed = pulseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "Expected only deviceId, pulse (0 or 1), a safe non-negative integer sequence, and ISO timestamp");
  }

  const result = await processPulse(store, parsed.data, token);
  const event = pulseBroadcast(result);

  if (event) {
    const io = getIO();
    io.to("dashboard").emit("pulseData", event);
    io.to(`device:${event.deviceId}`).emit("pulseData", event);
  }

  json(res, event ? 201 : 200, result);
}
