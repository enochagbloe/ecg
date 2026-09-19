import { createHash, timingSafeEqual } from "node:crypto";
import type { Device } from "@prisma/client";
import { HttpError } from "../utils/http";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const supplied = Buffer.from(hashSecret(secret), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  if (!match || match[1].length > 512) throw new HttpError(401, "Invalid device credentials");
  return match[1];
}

export function authenticateDevice(device: Device | null, token: string): Device {
  // Do not reveal whether a hardware ID exists to unauthenticated callers.
  if (!device || !secretMatches(token, device.apiKeyHash)) {
    throw new HttpError(401, "Invalid device credentials");
  }
  if (!device.isActive) throw new HttpError(403, "Device is disabled");
  return device;
}