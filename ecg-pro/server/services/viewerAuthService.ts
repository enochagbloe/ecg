import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { hashSecret, secretMatches } from "./deviceAuthService";
import { HttpError } from "../utils/http";

const cookieName = "ecg_viewer";
const sessionSeconds = 8 * 60 * 60;
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

function grantSession(res: ServerResponse, username: string, password: string): number {
  const expiresAt = Date.now() + sessionSeconds * 1000;
  const expires = String(expiresAt);
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=${expires}.${signature(expires, username, password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return expiresAt;
}

// Dashboard login form reuses the SAME signed HttpOnly session as Basic auth.
// Never return a session token to browser JavaScript.
export function loginViewer(username: string, password: string, res: ServerResponse): number {
  const configured = credentials();
  const usernameMatches = secretMatches(username, hashSecret(configured.username));
  const passwordMatches = secretMatches(password, hashSecret(configured.password));
  if (!usernameMatches || !passwordMatches) {
    throw new HttpError(401, "Invalid username or password");
  }
  return grantSession(res, configured.username, configured.password);
}

export function logoutViewer(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
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
      return res ? grantSession(res, username, password) : Date.now() + sessionSeconds * 1000;
    }
  }
  res?.setHeader("WWW-Authenticate", 'Basic realm="ECG Dashboard", charset="UTF-8"');
  throw new HttpError(401, "Dashboard authentication required");
}