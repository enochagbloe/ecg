-- Serialize the backfill with existing ingestion transactions. Both application
-- generations acquire the Device lock first. Waiting clients retain/retry IDs.
BEGIN;
SET LOCAL lock_timeout = '30s';
LOCK TABLE "Device", "PulseEvent", "MeterState" IN ACCESS EXCLUSIVE MODE;
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

-- Keep the ledger correct while old and new application instances overlap.
-- New ingestion also computes the same value before its final state upsert.
CREATE FUNCTION gridlora_event_energy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE constant integer;
BEGIN
 SELECT coalesce((SELECT "meterConstant" FROM "MeterPeriod" WHERE "deviceId"=NEW."deviceId"
   AND "startSequence"<=NEW.sequence ORDER BY "startSequence" DESC, revision DESC LIMIT 1),d."meterConstant")
 INTO constant FROM "Device" d WHERE d.id=NEW."deviceId";
 UPDATE "MeterState" SET "energyKWh"="energyKWh"+1.0/constant WHERE "deviceId"=NEW."deviceId";
 RETURN NEW;
END;
$$;
CREATE TRIGGER gridlora_event_energy AFTER INSERT ON "PulseEvent" FOR EACH ROW EXECUTE FUNCTION gridlora_event_energy();

-- A device can receive its first pulse before a MeterState row exists.
CREATE FUNCTION gridlora_initial_energy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Native UPSERT also fires BEFORE INSERT on an existing state. Keep that O(1).
 IF EXISTS (SELECT 1 FROM "MeterState" WHERE "deviceId"=NEW."deviceId") THEN
  RETURN NEW;
 END IF;
 SELECT coalesce(sum(1.0/coalesce((SELECT "meterConstant" FROM "MeterPeriod" m
   WHERE m."deviceId"=e."deviceId" AND m."startSequence"<=e.sequence
   ORDER BY m."startSequence" DESC,m.revision DESC LIMIT 1),d."meterConstant")),0)
 INTO NEW."energyKWh" FROM "PulseEvent" e JOIN "Device" d ON d.id=e."deviceId"
 WHERE e."deviceId"=NEW."deviceId";
 RETURN NEW;
END;
$$;
CREATE TRIGGER gridlora_initial_energy BEFORE INSERT ON "MeterState" FOR EACH ROW EXECUTE FUNCTION gridlora_initial_energy();

-- Older customer PATCH handlers cannot bypass the new history boundary.
CREATE FUNCTION gridlora_meter_constant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_constant integer;
BEGIN
 IF NEW."meterConstant" IS DISTINCT FROM OLD."meterConstant" THEN
  SELECT "meterConstant" INTO active_constant FROM "MeterPeriod" WHERE "deviceId"=OLD.id
   ORDER BY "startSequence" DESC,revision DESC LIMIT 1;
  IF active_constant IS NULL OR active_constant<>NEW."meterConstant" THEN
   RAISE EXCEPTION 'Meter changes require a reset-confirmed history period';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER gridlora_meter_constant_guard BEFORE UPDATE OF "meterConstant" ON "Device" FOR EACH ROW EXECUTE FUNCTION gridlora_meter_constant_guard();
COMMIT;
