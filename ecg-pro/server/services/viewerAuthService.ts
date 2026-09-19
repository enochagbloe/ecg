import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { hashSecret, secretMatches } from "./deviceAuthService";
import { HttpError } from "../utils/http";

const cookieName = "ecg_viewer";
function credentials() {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password || password.length < 32 || password.startsWith("replace-with-")) {
    throw new HttpError(503, "Dashboard credentials are not configured");
  }
  return { username, password };
}
function signature(expires: string, username: string, password: string) {
  return createHmac("sha256", password).update(`${username}:${expires}`).digest("hex");
}

// Central read-access boundary: replace with user sessions / per-device ACLs later.
export function authorizeViewer(req: IncomingMessage, res?: ServerResponse): number {
  const { username, password } = credentials();
  const session = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  if (session) {
    const [expires, supplied] = session.split(".");
    if (/^\d+$/.test(expires) && Number(expires) > Date.now() &&
        supplied && secretMatches(supplied, hashSecret(signature(expires, username, password)))) return Number(expires);
  }
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0 && secretMatches(decoded.slice(0, separator), hashSecret(username)) &&
        secretMatches(decoded.slice(separator + 1), hashSecret(password))) {
      const expires = String(Date.now() + 8 * 60 * 60 * 1000);
      if (res) {
        res.setHeader("Set-Cookie", `${cookieName}=${expires}.${signature(expires, username, password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      }
      return Number(expires);
    }
  }
  res?.setHeader("WWW-Authenticate", 'Basic realm="ECG Dashboard", charset="UTF-8"');
  throw new HttpError(401, "Dashboard authentication required");
}