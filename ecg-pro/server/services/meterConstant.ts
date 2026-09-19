import { z } from "zod";

// Shared by provisioning and authoritative calculations; no calibration default.
export const meterConstantSchema = z.number().int().min(1).max(100_000);