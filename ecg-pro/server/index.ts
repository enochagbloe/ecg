import "../libs/env";
import { createServer } from "node:http";
import next from "next";
import { initializeSocket } from "./socketServer";
import logger from "../libs/logger";
import { prisma } from "../libs/prisma";
import { devicePulse } from "./routes/devicePulse";
import { deviceState } from "./routes/deviceState";
import { createDeviceResetHandler } from "./routes/deviceReset";
import { createPrismaDeviceResetStore } from "./services/deviceResetService";
import { getIO } from "./socketServer";
import { authorizeViewer } from "./services/viewerAuthService";
import { HttpError, json } from "./utils/http";

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const hostname = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 3000);
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const deviceReset = createDeviceResetHandler(createPrismaDeviceResetStore(prisma), (event) => getIO().emit("deviceReset", event));
  const httpServer = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === "/api/v1/device/pulse") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          throw new HttpError(405, "Method not allowed");
        }
        await devicePulse(req, res);
        return;
      }
      const resetMatch = /^\/api\/v1\/devices\/([A-Za-z0-9_-]+)\/reset-test-data$/.exec(pathname);
      if (resetMatch) {
        await deviceReset(req, res, resetMatch[1]);
        return;
      }
      const stateMatch = /^\/api\/v1\/devices\/([A-Za-z0-9_-]+)\/state$/.exec(pathname);
      if (stateMatch) {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          throw new HttpError(405, "Method not allowed");
        }
        await deviceState(req, res, stateMatch[1]);
        return;
      }
      if (pathname.startsWith("/api/v1/")) throw new HttpError(404, "Endpoint not found");
      if (pathname === "/") authorizeViewer(req, res);
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      // Do not log request headers, bodies, device secrets, or connection URLs.
      if (status === 500) logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Request failed");
      if (!res.headersSent) {
        if (status === 413) res.setHeader("Connection", "close");
        json(res, status, { ok: false, error: error instanceof HttpError ? error.message : "Internal server error" });
      } else res.end();
    }
  });
  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 10_000;
  const io = initializeSocket(httpServer);
  httpServer.listen(port, hostname, () => logger.info(`Ready on port ${port}`));
  httpServer.on("error", () => { logger.error("HTTP server failed"); process.exitCode = 1; });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    io.close();
    httpServer.close(() => {
      void prisma.$disconnect().then(() => process.exit(0), () => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch(() => { logger.error("Server startup failed"); process.exitCode = 1; });