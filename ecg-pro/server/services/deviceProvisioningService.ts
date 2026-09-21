import type { Device, Prisma } from "@prisma/client";
import { z } from "zod";
import { hashSecret } from "./deviceAuthService";
import { meterConstantSchema } from "./meterConstant";

export const deviceProvisioningSchema = z.object({
  hardwareId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  secret: z.string().min(32).max(512).regex(/^\S+$/).refine((value) => !value.startsWith("replace-with-")),
  meterConstant: meterConstantSchema,
  claimCode: z.string().min(6).max(128).optional(),
}).strict();
export type DeviceProvisioningInput = z.infer<typeof deviceProvisioningSchema>;

export const bootstrapEnvironmentSchema = z.object({
  BOOTSTRAP_DEVICE_ID: deviceProvisioningSchema.shape.hardwareId,
  BOOTSTRAP_DEVICE_SECRET: deviceProvisioningSchema.shape.secret,
  BOOTSTRAP_METER_CONSTANT: z.string().trim().regex(/^\d+$/).transform(Number).pipe(meterConstantSchema),
  BOOTSTRAP_DEVICE_CLAIM_CODE: z.string().min(6).max(128).optional(),
}).transform((env): DeviceProvisioningInput => ({
  hardwareId: env.BOOTSTRAP_DEVICE_ID,
  secret: env.BOOTSTRAP_DEVICE_SECRET,
  meterConstant: env.BOOTSTRAP_METER_CONSTANT,
  claimCode: env.BOOTSTRAP_DEVICE_CLAIM_CODE,
}));

interface BootstrapDeviceWrite {
  where: { hardwareId: string };
  create: Prisma.DeviceCreateInput;
  update: Prisma.DeviceUpdateInput;
}
export interface BootstrapDeviceStore {
  upsert(write: BootstrapDeviceWrite): Promise<Device>;
}

export async function provisionBootstrapDevice(store: BootstrapDeviceStore, input: DeviceProvisioningInput): Promise<Device> {
  const { hardwareId, secret, meterConstant, claimCode } = deviceProvisioningSchema.parse(input);
  const apiKeyHash = hashSecret(secret);
  const claimCodeHash = claimCode ? hashSecret(claimCode) : undefined;
  return store.upsert({
    where: { hardwareId },
    create: {
      hardwareId,
      apiKeyHash,
      meterConstant,
      claimCodeHash: claimCodeHash ?? null,
      meterState: { create: {} },
    },
    update: {
      apiKeyHash,
      ...(claimCodeHash ? { claimCodeHash } : {}),
    },
  });
}
