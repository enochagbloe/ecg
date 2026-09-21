import "../libs/env";
import { prisma } from "../libs/prisma";
import { bootstrapEnvironmentSchema, provisionBootstrapDevice } from "../server/services/deviceProvisioningService";

async function seed() {
  const input = bootstrapEnvironmentSchema.parse(process.env);
  await provisionBootstrapDevice(prisma.device, input);
  console.log("Bootstrap device provisioned");
}
seed().catch(() => {
  console.error("Seed failed. Check database connectivity and BOOTSTRAP_DEVICE_ID, BOOTSTRAP_DEVICE_SECRET, BOOTSTRAP_METER_CONSTANT, and optional BOOTSTRAP_DEVICE_CLAIM_CODE.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
