ALTER TABLE "Device" ADD COLUMN "claimCodeHash" TEXT;

CREATE TABLE "CustomerUser" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "CustomerUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceOwnership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceOwnership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerUser_email_key" ON "CustomerUser"("email");
CREATE UNIQUE INDEX "CustomerSession_tokenHash_key" ON "CustomerSession"("tokenHash");
CREATE INDEX "CustomerSession_userId_idx" ON "CustomerSession"("userId");
CREATE INDEX "CustomerSession_expiresAt_idx" ON "CustomerSession"("expiresAt");
CREATE UNIQUE INDEX "DeviceOwnership_deviceId_key" ON "DeviceOwnership"("deviceId");
CREATE INDEX "DeviceOwnership_userId_idx" ON "DeviceOwnership"("userId");

ALTER TABLE "CustomerSession"
ADD CONSTRAINT "CustomerSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "CustomerUser"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeviceOwnership"
ADD CONSTRAINT "DeviceOwnership_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "CustomerUser"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeviceOwnership"
ADD CONSTRAINT "DeviceOwnership_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
