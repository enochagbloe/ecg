-- Preserve published migration history and all existing device calibrations.
-- Device_meterConstant_positive remains in place.
ALTER TABLE "Device" ALTER COLUMN "meterConstant" DROP DEFAULT;