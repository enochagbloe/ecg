import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { HttpError, json } from "../utils/http";

export async function health(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

  try {
    await prisma.customerUser.count();
    json(res, 200, { ok: true, database: "connected" });
  } catch {
    json(res, 503, { ok: false, database: "unavailable" });
  }
}
