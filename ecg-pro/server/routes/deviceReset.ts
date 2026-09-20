import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeviceResetEvent } from "../../libs/deviceEvents";
import { authorizeViewer } from "../services/viewerAuthService";
import { resetDeviceTestData, type DeviceResetStore } from "../services/deviceResetService";
import { HttpError, json } from "../utils/http";

// Inject only persistence and broadcasting; production uses the shared Socket.io instance.
export function createDeviceResetHandler(store: DeviceResetStore, emit: (event: DeviceResetEvent) => void) {
  return async (req: IncomingMessage, res: ServerResponse, hardwareId: string) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new HttpError(405, "Method not allowed");
    }
    authorizeViewer(req, res);
    if (process.env.NODE_ENV === "production" && process.env.ENABLE_TEST_RESET !== "true") {
      throw new HttpError(404, "Endpoint not found");
    }
    // A custom header prevents cross-site forms from using ambient Basic/cookie credentials.
    if (req.headers["x-ecg-test-reset"] !== "true") throw new HttpError(403, "X-ECG-Test-Reset: true is required");
    if (req.headers.origin && req.headers.origin !== (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000")) {
      throw new HttpError(403, "Origin not allowed");
    }
    const result = await resetDeviceTestData(store, hardwareId);
    // The transaction promise has committed. No event can escape a rolled-back reset.
    emit({ deviceId: result.deviceId, pulseCount: 0, energyKWh: 0, powerKw: 0, lastPulseAt: null, lastSeenAt: null });
    json(res, 200, result);
  };
}