import type { IncomingMessage, ServerResponse } from "node:http";
import { prisma } from "../../libs/prisma";
import { authorizeViewer } from "../services/viewerAuthService";
import { authorizeCustomer } from "../services/customerAuthService";
import { bearerToken } from "../services/deviceAuthService";
import { createMeterSettingsService } from "../services/meterSettingsService";
import { HttpError, json, readJson } from "../utils/http";
export function createMeterSettingsHandler(
  client: typeof prisma,
  customerAuth = authorizeCustomer,
) {
  const service = createMeterSettingsService(client);
  return async function meterSettings(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    customer = false,
  ) {
    if (customer) {
      const auth = await customerAuth(req);
      if (
        !(await client.deviceOwnership.findFirst({
          where: { userId: auth.user.id, device: { hardwareId: id } },
        }))
      )
        throw new HttpError(404, "Device not found");
    } else authorizeViewer(req, res);
    if (req.method === "GET") return json(res, 200, await service.read(id));
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    // Same-origin JSON plus strict session cookies prevents cross-site changes.
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(403, "Cross-site settings changes are forbidden");
    json(res, 200, await service.change(id, await readJson(req)));
  };
}
export const meterSettings = createMeterSettingsHandler(prisma);
const service = createMeterSettingsService(prisma);
export async function deviceBoot(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  json(
    res,
    200,
    await service.report(
      await readJson(req),
      bearerToken(req.headers.authorization),
    ),
  );
}
