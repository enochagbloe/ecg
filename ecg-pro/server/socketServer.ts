import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "../libs/prisma";
import logger from "../libs/logger";
import { scheduleSessionExpiry } from "./utils/sessionExpiry";
import { authenticateCustomerToken } from "./services/customerAuthService";
import { authorizeViewer } from "./services/viewerAuthService";

let io: SocketIOServer | null = null;

export function initializeSocket(httpServer: HTTPServer) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  io = new SocketIOServer(httpServer, {
    cors: { origin, methods: ["GET", "POST"], credentials: true },
    // Native mobile clients may supply no Origin or a platform-specific one.
    // Authentication is enforced in Socket.io middleware below.
    allowRequest: (_req, callback) => callback(null, true),
  });

  io.use(async (socket, next) => {
    try {
      const token = typeof socket.handshake.auth?.token === "string"
        ? socket.handshake.auth.token
        : null;

      if (token) {
        const auth = await authenticateCustomerToken(token);
        socket.data.customerUserId = auth.user.id;
        socket.data.expiresAt = auth.expiresAt.getTime();
        next();
        return;
      }

      const expiresAt = authorizeViewer(socket.request);
      socket.data.dashboardViewer = true;
      socket.data.expiresAt = expiresAt;
      next();
    } catch {
      next(new Error("Authentication required"));
    }
  });

  io.on("connection", async (socket) => {
    const expiresAt = Number(socket.data.expiresAt || Date.now());

    const cancelExpiry = scheduleSessionExpiry(expiresAt, () => socket.disconnect(true));
    socket.once("disconnect", cancelExpiry);

    try {
      if (socket.data.customerUserId) {
        const rows = await prisma.deviceOwnership.findMany({
          where: { userId: String(socket.data.customerUserId) },
          include: { device: true },
        });
        if (!socket.connected) return;
        for (const row of rows) {
          await socket.join(`device:${row.device.hardwareId}`);
        }
      } else {
        await socket.join("dashboard");
      }
    } catch {
      logger.error("Socket room initialization failed");
      socket.disconnect(true);
    }
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.io is not initialized");
  return io;
}
