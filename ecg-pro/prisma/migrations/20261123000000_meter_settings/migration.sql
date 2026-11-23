ALTER TABLE "MeterState" ADD COLUMN "energyKWh" DOUBLE PRECISION NOT NULL DEFAULT 0;
UPDATE "MeterState" s SET "energyKWh" = s."totalPulses"::double precision / d."meterConstant" FROM "Device" d WHERE d.id = s."deviceId";
CREATE TABLE "DeviceSettings" (
 "deviceId" TEXT PRIMARY KEY REFERENCES "Device"(id) ON DELETE RESTRICT,
 "bootId" TEXT, "bootFirstSeenAt" TIMESTAMPTZ(3), "bootHead" BIGINT,
 "firmwareVersion" TEXT, "pendingConstant" INTEGER, "pendingLabel" TEXT,
 "requestedAt" TIMESTAMPTZ(3), "expectedBootId" TEXT,
 "requestId" TEXT, "completedRequestId" TEXT, "armedAt" TIMESTAMPTZ(3),
 CHECK ("pendingConstant" IS NULL OR "pendingConstant" BETWEEN 1 AND 100000)
);
CREATE TABLE "MeterPeriod" (
 revision SERIAL UNIQUE, id TEXT PRIMARY KEY, "deviceId" TEXT NOT NULL REFERENCES "Device"(id) ON DELETE RESTRICT,
 "startSequence" BIGINT NOT NULL, "meterConstant" INTEGER NOT NULL CHECK ("meterConstant" BETWEEN 1 AND 100000),
 label TEXT NOT NULL, "effectiveAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "confirmedBootId" TEXT
);
INSERT INTO "MeterPeriod" (id,"deviceId","startSequence","meterConstant",label,"effectiveAt")
 SELECT 'legacy-' || id,id,0,"meterConstant",'Original configuration (imported)',"createdAt" FROM "Device";

CREATE TABLE "DeviceBoot" ("deviceId" TEXT NOT NULL, "bootId" TEXT NOT NULL, "bootHead" BIGINT NOT NULL, "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY("deviceId","bootId"));

CREATE INDEX "MeterPeriod_deviceId_startSequence_idx" ON "MeterPeriod" ("deviceId","startSequence");
