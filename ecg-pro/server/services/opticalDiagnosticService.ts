import { z } from "zod";

export const opticalDiagnosticSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  diagnosticOnly: z.boolean(),
  minimum: z.number().int().min(0).max(4095),
  maximum: z.number().int().min(0).max(4095),
  baseline: z.number().int().min(0).max(4095),
  peakDelta: z.number().int().min(0).max(4095),
  onDelta: z.number().int().min(0).max(4095),
  offDelta: z.number().int().min(0).max(4095),
  samples: z.number().int().nonnegative().max(10000000),
  candidates: z.number().int().nonnegative().max(10000000),
  detected: z.number().int().nonnegative().max(10000000),
  shortRejected: z.number().int().nonnegative().max(10000000),
  // Optional for backward compatibility with previously flashed ESP32 firmware.
  widthSamples: z.number().int().nonnegative().max(10000000).optional(),
  minWidthUs: z.number().int().nonnegative().max(10000000).optional(),
  maxWidthUs: z.number().int().nonnegative().max(10000000).optional(),
  averageWidthUs: z.number().int().nonnegative().max(10000000).optional(),
  lastWidthUs: z.number().int().nonnegative().max(10000000).optional(),
  maxShortWidthUs: z.number().int().nonnegative().max(10000000).optional(),
  longRejected: z.number().int().nonnegative().max(10000000),
  saturatedSamples: z.number().int().nonnegative().max(10000000),
  queueDrops: z.number().int().nonnegative().max(10000000),
  armed: z.boolean(),
}).strict();

export type OpticalDiagnosticInput = z.infer<typeof opticalDiagnosticSchema>;
export type OpticalDiagnostic = OpticalDiagnosticInput & { receivedAt: string };

// Prototype-only bounded in-memory history. Logs reset when Render redeploys.
// Pulse events continue to use their independent durable PostgreSQL store.
const HISTORY_LIMIT = 60;
const MAX_DEVICES = 100;
const histories = new Map<string, OpticalDiagnostic[]>();
const lastAccepted = new Map<string, number>();

export function appendOpticalDiagnostic(value: OpticalDiagnosticInput, now = Date.now()): OpticalDiagnostic | null {
  const previous = lastAccepted.get(value.deviceId) ?? 0;
  if (now - previous < 1500) return null; // bounded ingest per device

  if (!histories.has(value.deviceId) && histories.size >= MAX_DEVICES) {
    const oldest = histories.keys().next().value;
    if (oldest) { histories.delete(oldest); lastAccepted.delete(oldest); }
  }
  const entry: OpticalDiagnostic = { ...value, receivedAt: new Date(now).toISOString() };
  const list = histories.get(value.deviceId) ?? [];
  list.push(entry);
  if (list.length > HISTORY_LIMIT) list.shift();
  histories.delete(value.deviceId);
  histories.set(value.deviceId, list);
  lastAccepted.set(value.deviceId, now);
  return entry;
}

export function recentOpticalDiagnostics(deviceId: string): OpticalDiagnostic[] {
  return [...(histories.get(deviceId) ?? [])];
}
