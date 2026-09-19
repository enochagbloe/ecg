import "../libs/env";
import { z } from "zod";
import { prisma } from "../libs/prisma";
import { hashSecret } from "../server/services/deviceAuthService";

async function seed() {
  const env = z.object({
    BOOTSTRAP_DEVICE_ID: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    BOOTSTRAP_DEVICE_SECRET: z.string().min(32).max(512).regex(/^\S+$/).refine((value) => value !== "replace-with-long-random-secret"),
  }).parse(process.env);
  await prisma.device.upsert({
    where: { hardwareId: env.BOOTSTRAP_DEVICE_ID },
    create: { hardwareId: env.BOOTSTRAP_DEVICE_ID, apiKeyHash: hashSecret(env.BOOTSTRAP_DEVICE_SECRET), meterState: { create: {} } },
    // Rerunning rotates credentials without resetting history, calibration, or disabled status.
    update: { apiKeyHash: hashSecret(env.BOOTSTRAP_DEVICE_SECRET) },
  });
  console.log("Bootstrap device provisioned");
}
seed().catch(() => {
  console.error("Seed failed. Check database connectivity and bootstrap environment configuration.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());