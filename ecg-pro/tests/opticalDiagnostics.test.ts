import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendOpticalDiagnostic,
  opticalDiagnosticSchema,
  recentOpticalDiagnostics,
  type OpticalDiagnosticInput,
} from "../server/services/opticalDiagnosticService";

function make(deviceId: string): OpticalDiagnosticInput {
  return {
    deviceId, diagnosticOnly: true, minimum: 0, maximum: 432,
    baseline: 0, peakDelta: 432, onDelta: 30, offDelta: 10,
    samples: 110000, candidates: 10, detected: 2,
    shortRejected: 8, longRejected: 0, saturatedSamples: 0,
    queueDrops: 0, armed: true,
  };
}

test("remote optical diagnostics validates bounded telemetry only", () => {
  assert.equal(opticalDiagnosticSchema.safeParse(make("ECG-test")).success, true);
  assert.equal(opticalDiagnosticSchema.safeParse({ ...make("ECG-test"), maximum: 5000 }).success, false);
  assert.equal(opticalDiagnosticSchema.safeParse({ ...make("ECG-test"), deviceSecret: "leak" }).success, false);
  assert.equal(opticalDiagnosticSchema.safeParse({ ...make("ECG-test"), samples: -1 }).success, false);
});

test("diagnostic history is rate limited and bounded, independently per device", () => {
  const deviceId = "ECG-test-diagnostics-unique";
  const other = "ECG-test-diagnostics-other";
  const t0 = Date.parse("2026-10-26T00:00:00.000Z");
  assert.ok(appendOpticalDiagnostic(make(deviceId), t0));
  assert.equal(appendOpticalDiagnostic(make(deviceId), t0 + 200), null);
  assert.ok(appendOpticalDiagnostic(make(other), t0 + 200));
  for (let i = 1; i <= 80; i++) appendOpticalDiagnostic(make(deviceId), t0 + i * 2000);
  const history = recentOpticalDiagnostics(deviceId);
  assert.equal(history.length, 60);
  assert.equal(history[0].receivedAt, new Date(t0 + 21 * 2000).toISOString());
  assert.equal(recentOpticalDiagnostics(other).length, 1);
});
