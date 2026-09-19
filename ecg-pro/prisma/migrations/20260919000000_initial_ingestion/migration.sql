-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "hardwareId" TEXT NOT NULL,
    "name" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "meterConstant" INTEGER NOT NULL DEFAULT 1600,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMPTZ(3),
    "firmwareVersion" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterState" (
    "deviceId" TEXT NOT NULL,
    "totalPulses" BIGINT NOT NULL DEFAULT 0,
    "lastSequence" BIGINT,
    "lastPulseAt" TIMESTAMPTZ(3),
    "lastIntervalMs" BIGINT,
    "powerKw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MeterState_pkey" PRIMARY KEY ("deviceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_hardwareId_key" ON "Device"("hardwareId");

-- CreateIndex
CREATE INDEX "PulseEvent_deviceId_occurredAt_idx" ON "PulseEvent"("deviceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PulseEvent_deviceId_sequence_key" ON "PulseEvent"("deviceId", "sequence");

-- AddForeignKey
ALTER TABLE "PulseEvent" ADD CONSTRAINT "PulseEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterState" ADD CONSTRAINT "MeterState_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce invariants even for writes outside the application.
ALTER TABLE "Device" ADD CONSTRAINT "Device_meterConstant_positive" CHECK ("meterConstant" > 0);
ALTER TABLE "Device" ADD CONSTRAINT "Device_apiKeyHash_sha256" CHECK ("apiKeyHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "PulseEvent" ADD CONSTRAINT "PulseEvent_sequence_safe" CHECK ("sequence" BETWEEN 0 AND 9007199254740991);
ALTER TABLE "MeterState" ADD CONSTRAINT "MeterState_totalPulses_safe" CHECK ("totalPulses" BETWEEN 0 AND 9007199254740991);
ALTER TABLE "MeterState" ADD CONSTRAINT "MeterState_lastSequence_safe" CHECK ("lastSequence" IS NULL OR "lastSequence" BETWEEN 0 AND 9007199254740991);
ALTER TABLE "MeterState" ADD CONSTRAINT "MeterState_interval_positive" CHECK ("lastIntervalMs" IS NULL OR "lastIntervalMs" > 0);
ALTER TABLE "MeterState" ADD CONSTRAINT "MeterState_power_valid" CHECK ("powerKw" >= 0 AND "powerKw" < 'Infinity'::double precision);
