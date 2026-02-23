import dotenv from "dotenv";

// Load environment variables FIRST before any other imports
const result = dotenv.config({ path: ".env.local" });
console.log("Dotenv result:", result.error ? result.error : "Loaded successfully");
console.log("MONGODB_URI:", process.env.MONGODB_URI ? "Found" : "NOT FOUND");

import { createServer } from "http";
import next from "next";
import { initializeSocket } from "./socketServer";
import logger from "../libs/logger";
import ECGMonitor from "../injest/ecg_plot"; // Import to start serial port monitoring

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  // Initialize Socket.io
  initializeSocket(httpServer);
  logger.info("Socket.io server initialized");
  
  // Start ECG monitor
  new ECGMonitor();
  logger.info("ECG Monitor started");

  httpServer.listen(port, () => {
    logger.info(`> Ready on http://${hostname}:${port}`);
  });
});
