import type { DeviceResetEvent } from "../../libs/deviceEvents";

export interface PulseData {
  deviceId: string;
  pulseCount: number;
  timestamp: string | null;
  energyKWh: number;
  powerKw: number;
}

// Shared by the component and its tests. Revisions invalidate stale HTTP responses.
export function createMeterUpdates(deviceId: string, publish: (data: PulseData) => void) {
  let revision = 0;
  let current: PulseData | null = null;
  const accept = (data: PulseData) => { current = data; revision++; publish(data); };
  return {
    pulse(data: PulseData) {
      if (data.deviceId !== deviceId || (current && data.pulseCount < current.pulseCount)) return;
      accept(data);
    },
    reset(event: DeviceResetEvent) {
      if (event.deviceId !== deviceId) return;
      accept({ deviceId, pulseCount: 0, energyKWh: 0, powerKw: 0, timestamp: null });
    },
    beginSnapshot() { return ++revision; },
    isCurrent(token: number) { return revision === token; },
    snapshot(token: number, data: PulseData) {
      if (token !== revision || data.deviceId !== deviceId) return;
      // A reconnect may have missed a reset: a fresh authoritative snapshot can decrease totals.
      accept(data);
    },
  };
}