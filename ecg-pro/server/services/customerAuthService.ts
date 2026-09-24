import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../libs/prisma";
import { HttpError } from "../utils/http";

const DEFAULT_SESSION_DAYS = 30;
const MAX_SESSION_DAYS = 365;

type CustomerAuthStore = Pick<Prisma.TransactionClient, "customerSession">;

export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getCustomerSessionDurationMs(): number {
  const raw = process.env.CUSTOMER_SESSION_DAYS?.trim();
  if (!raw) return DEFAULT_SESSION_DAYS * 24 * 60 * 60 * 1000;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_SESSION_DAYS) {
    throw new Error("CUSTOMER_SESSION_DAYS must be an integer between 1 and " + MAX_SESSION_DAYS);
  }

  return days * 24 * 60 * 60 * 1000;
}

export function hashCustomerSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashCustomerPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}

export function verifyCustomerPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  try {
    const expected = Buffer.from(parts[2], "hex");
    if (expected.length !== 32) return false;

    const supplied = scryptSync(password, parts[1], 32);
    return timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}

export function customerBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  if (!match || match[1].length > 512) {
    throw new HttpError(401, "Invalid customer session");
  }
  return match[1];
}

export async function createCustomerSession(
  userId: string,
  store: CustomerAuthStore = prisma,
) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashCustomerSessionToken(token);
  const expiresAt = new Date(Date.now() + getCustomerSessionDurationMs());

  await store.customerSession.create({
    data: { userId, tokenHash, expiresAt },
  });

  return { token, expiresAt };
}

export async function authenticateCustomerToken(
  token: string,
  store: CustomerAuthStore = prisma,
) {
  if (!token || token.length > 512) {
    throw new HttpError(401, "Invalid customer session");
  }

  const tokenHash = hashCustomerSessionToken(token);
  const session = await store.customerSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) {
    throw new HttpError(401, "Invalid or expired customer session");
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await store.customerSession.deleteMany({ where: { id: session.id } });
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

export async function revokeCustomerSession(
  token: string,
  store: CustomerAuthStore = prisma,
) {
  await store.customerSession.deleteMany({
    where: { tokenHash: hashCustomerSessionToken(token) },
  });
}
