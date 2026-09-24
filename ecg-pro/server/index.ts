import "../libs/env";
import { createServer } from "node:http";
import next from "next";
import { initializeSocket, getIO } from "./socketServer";
import logger from "../libs/logger";
import { prisma } from "../libs/prisma";
import { devicePulse } from "./routes/devicePulse";
import { deviceState } from "./routes/deviceState";
import { createDeviceResetHandler } from "./routes/deviceReset";
import { health } from "./routes/health";
import {
  customerForgotPassword,
  customerLogin,
  customerLogout,
  customerMe,
  customerRegister,
} from "./routes/customerAuth";
import {
  customerClaimDevice,
  customerDeviceState,
  customerListDevices,
  customerRemoveDevice,
  customerUpdateDevice,
} from "./routes/customerDevices";
import { createPrismaDeviceResetStore } from "./services/deviceResetService";
import { getCustomerSessionDurationMs } from "./services/customerAuthService";
import { authorizeViewer } from "./services/viewerAuthService";
import { HttpError, json } from "./utils/http";

async function main() {
  const dev = process.env.NODE_ENV !== "production";
  const hostname = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 3000);

  getCustomerSessionDurationMs();

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  await prisma.$connect();
  await prisma.customerUser.count();
  logger.info("Database connected");
  logger.info("Customer authentication ready");

  const deviceReset = createDeviceResetHandler(
    createPrismaDeviceResetStore(prisma),
    (event) => {
      const io = getIO();
      io.to("dashboard").emit("deviceReset", event);
      io.to("device:" + event.deviceId).emit("deviceReset", event);
    },
  );

  const httpServer = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;

      if (pathname === "/api/v1/health") {
        await health(req, res);
        return;
      }

      if (pathname === "/api/v1/auth/register") {
        await customerRegister(req, res);
        return;
      }
      if (pathname === "/api/v1/auth/login") {
        await customerLogin(req, res);
        return;
      }
      if (pathname === "/api/v1/auth/me") {
        await customerMe(req, res);
        return;
      }
      if (pathname === "/api/v1/auth/logout") {
        await customerLogout(req, res);
        return;
      }
      if (pathname === "/api/v1/auth/forgot-password") {
        await customerForgotPassword(req, res);
        return;
      }

      if (pathname === "/api/v1/customer/devices/claim") {
        await customerClaimDevice(req, res);
        return;
      }
      if (pathname === "/api/v1/customer/devices") {
        await customerListDevices(req, res);
        return;
      }

      const customerStateMatch =
        /^\/api\/v1\/customer\/devices\/([A-Za-z0-9_-]+)\/state$/.exec(pathname);
      if (customerStateMatch) {
        await customerDeviceState(req, res, customerStateMatch[1]);
        return;
      }

      const customerDeviceMatch =
        /^\/api\/v1\/customer\/devices\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (customerDeviceMatch) {
        if (req.method === "PATCH") {
          await customerUpdateDevice(req, res, customerDeviceMatch[1]);
          return;
        }
        if (req.method === "DELETE") {
          await customerRemoveDevice(req, res, customerDeviceMatch[1]);
          return;
        }
        res.setHeader("Allow", "PATCH, DELETE");
        throw new HttpError(405, "Method not allowed");
      }

      if (pathname === "/api/v1/device/pulse") {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          throw new HttpError(405, "Method not allowed");
        }
        await devicePulse(req, res);
        return;
      }

      const resetMatch =
        /^\/api\/v1\/devices\/([A-Za-z0-9_-]+)\/reset-test-data$/.exec(pathname);
      if (resetMatch) {
        await deviceReset(req, res, resetMatch[1]);
        return;
      }

      const stateMatch =
        /^\/api\/v1\/devices\/([A-Za-z0-9_-]+)\/state$/.exec(pathname);
      if (stateMatch) {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          throw new HttpError(405, "Method not allowed");
        }
        await deviceState(req, res, stateMatch[1]);
        return;
      }

      if (pathname.startsWith("/api/v1/")) {
        throw new HttpError(404, "Endpoint not found");
      }

      if (pathname === "/") authorizeViewer(req, res);
      await handle(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;

      if (status === 500) {
        logger.error(
          { errorType: error instanceof Error ? error.name : "UnknownError" },
          "Request failed",
        );
      }

      if (!res.headersSent) {
        if (status === 413) res.setHeader("Connection", "close");
        json(res, status, {
          ok: false,
          error:
            error instanceof HttpError
              ? error.message
              : "Internal server error",
        });
      } else {
        res.end();
      }
    }
  });

  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 10_000;

  const io = initializeSocket(httpServer);

  httpServer.listen(port, hostname, () => {
    logger.info("Ready on port " + port);
  });

  httpServer.on("error", () => {
    logger.error("HTTP server failed");
    process.exitCode = 1;
  });

  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    io.close();
    httpServer.close(() => {
      void prisma.$disconnect().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  logger.error(
    { errorType: error instanceof Error ? error.name : "UnknownError" },
    "Server startup failed. Check database connectivity and deployed migrations.",
  );
  process.exitCode = 1;
});
