import type { Server as HTTPServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { authorizeViewer } from "./services/viewerAuthService";

let io: SocketIOServer | null = null;
export function initializeSocket(httpServer: HTTPServer) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  io = new SocketIOServer(httpServer, {
    cors: { origin, methods: ["GET", "POST"], credentials: true },
    allowRequest: (req, callback) => {
      try {
        if (req.headers.origin && req.headers.origin !== origin) return callback("Origin not allowed", false);
        authorizeViewer(req);
        callback(null, true);
      } catch {
        callback("Dashboard authentication required", false);
      }
    },
  });
  io.on("connection", (socket) => {
    // Bound sessions even for long-lived connections; the client reauthenticates on reconnect.
    const expiresAt = authorizeViewer(socket.request);
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    socket.on("disconnect", () => clearTimeout(timer));
  });
  return io;
}
export function getIO(): SocketIOServer {
  if (!io) throw new Error("Socket.io is not initialized");
  return io;
}