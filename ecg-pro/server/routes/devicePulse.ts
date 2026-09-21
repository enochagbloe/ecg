import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { bearerToken } from "../services/deviceAuthService";
import { createPrismaPulseStore } from "../services/prismaPulseStore";
import { processPulse, pulseBroadcast, pulseSchema } from "../services/pulseService";
import { getIO } from "../socketServer";
import { HttpError, json, readJson } from "../utils/http";

const store = createPrismaPulseStore(prisma);

export async function devicePulse(req: IncomingMessage, res: ServerResponse) {
  const token = bearerToken(req.headers.authorization);
  const parsed = pulseSchema.safeParse(await readJson(req));
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
