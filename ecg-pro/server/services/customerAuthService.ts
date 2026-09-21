import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { prisma } from "../../libs/prisma";
import { HttpError } from "../utils/http";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashCustomerPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyCustomerPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  const supplied = scryptSync(password, parts[1], 32);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function customerBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  if (!match || match[1].length > 512) throw new HttpError(401, "Invalid customer session");
  return match[1];
}

export async function createCustomerSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await prisma.customerSession.create({
    data: { userId, tokenHash: sessionHash(token), expiresAt },
  });
  return { token, expiresAt };
}

export async function authenticateCustomerToken(token: string) {
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: sessionHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, "Invalid or expired customer session");
  }
  return {
    user: session.user,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  };
}

export async function authorizeCustomer(req: IncomingMessage) {
  return authenticateCustomerToken(customerBearerToken(req.headers.authorization));
}

export async function revokeCustomerSession(token: string) {
  await prisma.customerSession.deleteMany({ where: { tokenHash: sessionHash(token) } });
}
