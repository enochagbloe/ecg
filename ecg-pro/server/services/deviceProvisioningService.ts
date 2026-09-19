import type { Device, Prisma } from "@prisma/client";
import { z } from "zod";
import { hashSecret } from "./deviceAuthService";
import { meterConstantSchema } from "./meterConstant";

export const deviceProvisioningSchema = z.object({
  hardwareId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  secret: z.string().min(32).max(512).regex(/^\S+$/).refine((value) => !value.startsWith("replace-with-")),
  meterConstant: meterConstantSchema,
}).strict();
export type DeviceProvisioningInput = z.infer<typeof deviceProvisioningSchema>;

export const bootstrapEnvironmentSchema = z.object({
  BOOTSTRAP_DEVICE_ID: deviceProvisioningSchema.shape.hardwareId,
  BOOTSTRAP_DEVICE_SECRET: deviceProvisioningSchema.shape.secret,
  BOOTSTRAP_METER_CONSTANT: z.string().trim().regex(/^\d+$/).transform(Number).pipe(meterConstantSchema),
}).transform((env): DeviceProvisioningInput => ({
  hardwareId: env.BOOTSTRAP_DEVICE_ID,
  secret: env.BOOTSTRAP_DEVICE_SECRET,
  meterConstant: env.BOOTSTRAP_METER_CONSTANT,
}));

interface BootstrapDeviceWrite {
  where: { hardwareId: string };
  create: Prisma.DeviceCreateInput;
  update: { apiKeyHash: string };
}
export interface BootstrapDeviceStore {
  upsert(write: BootstrapDeviceWrite): Promise<Device>;
}

// The bootstrap operation can rotate a token but cannot recalibrate an existing meter.
// Future provisioning entry points must validate the same required three properties.
export async function provisionBootstrapDevice(store: BootstrapDeviceStore, input: DeviceProvisioningInput): Promise<Device> {
  const { hardwareId, secret, meterConstant } = deviceProvisioningSchema.parse(input);
  const apiKeyHash = hashSecret(secret);
  return store.upsert({
    where: { hardwareId },
    create: { hardwareId, apiKeyHash, meterConstant, meterState: { create: {} } },
    update: { apiKeyHash },
  });
}