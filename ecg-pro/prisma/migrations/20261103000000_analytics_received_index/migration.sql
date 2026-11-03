-- Additive receipt-time index for bounded clock-quality queries. No records change.
CREATE INDEX "PulseEvent_deviceId_receivedAt_idx" ON "PulseEvent"("deviceId", "receivedAt");
