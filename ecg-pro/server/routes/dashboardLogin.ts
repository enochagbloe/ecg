import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { loginViewer, logoutViewer } from "../services/viewerAuthService";
import { HttpError, json, readJson } from "../utils/http";

const credentialsSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
}).strict();

// Best-effort in-memory rate limit on the *actual* connection remote address.
// No reliance on spoofable X-Forwarded-For headers. Resets after deployments.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_TRACKED_ADDRESSES = 1000;
const failures = new Map<string, { count: number; since: number }>();

export async function dashboardLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    throw new HttpError(405, "Method not allowed");
  }

  const address = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = failures.get(address);
  if (current && now - current.since < WINDOW_MS && current.count >= MAX_FAILURES) {
    throw new HttpError(429, "Too many login attempts. Try again later.");
  }

  const parsed = credentialsSchema.safeParse(await readJson(req));
  if (!parsed.success) throw new HttpError(400, "Enter a valid username and password.");

  try {
    loginViewer(parsed.data.username, parsed.data.password, res);
    failures.delete(address);
    json(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      const last = failures.get(address);
      if (failures.size >= MAX_TRACKED_ADDRESSES && !last) {
        const key = failures.keys().next().value;
        if (key) failures.delete(key);
      }
      failures.set(address, !last || now - last.since >= WINDOW_MS
        ? { count: 1, since: now }
        : { count: last.count + 1, since: last.since });
    }
    throw error;
  }
}

export function dashboardLogout(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    throw new HttpError(405, "Method not allowed");
  }

  // SameSite=Strict, no CORS headers and a JSON-only POST avoid cross-site logouts.
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  logoutViewer(res);
  json(res, 200, { ok: true });
}
