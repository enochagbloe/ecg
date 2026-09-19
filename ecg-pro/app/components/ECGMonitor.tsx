"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";

interface PulseData {
  deviceId: string;
  pulseCount: number;
  timestamp: string | null;
  energyKWh: number;
  powerKw: number;
}

export default function ECGMonitor() {
  const [pulseData, setPulseData] = useState<PulseData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const deviceId = process.env.NEXT_PUBLIC_DEVICE_ID || "ECG-001";
    const controller = new AbortController();
    let active = true;
    const update = (data: PulseData) => {
      if (!active || data.deviceId !== deviceId) return;
      setPulseData((previous) => previous && previous.pulseCount > data.pulseCount ? previous : data);
      setLoadError(null);
    };
    const loadState = async () => {
      try {
        const response = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/state`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Unable to load meter state (HTTP ${response.status}).`);
        const state: { deviceId: string; totalPulses: number; lastPulseAt: string | null; energyKWh: number; powerKw: number } = await response.json();
        update({ deviceId: state.deviceId, pulseCount: state.totalPulses, timestamp: state.lastPulseAt,
          energyKWh: state.energyKWh, powerKw: state.powerKw });
      } catch (error) {
        if (active && !controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Unable to load meter state.");
      }
    };
    const socketInstance = io({ transports: ["websocket"], withCredentials: true });
    socketInstance.on("connect", () => {
      setIsConnected(true);
      void loadState();
    });
    socketInstance.on("disconnect", () => setIsConnected(false));
    socketInstance.on("connect_error", () => setIsConnected(false));
    socketInstance.on("pulseData", update);
    void loadState();
    return () => {
      active = false;
      controller.abort();
      socketInstance.disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-bold text-gray-800">ECG Energy Monitor</h1>
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  isConnected ? "bg-green-500" : "bg-red-500"
                } animate-pulse`}
              />
              <span className="text-sm text-gray-600">
                {isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>

          {pulseData ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <MetricCard
                title="Total Pulses"
                value={pulseData.pulseCount}
                unit="pulses"
                color="blue"
              />
              <MetricCard
                title="Energy Consumed"
                value={pulseData.energyKWh.toFixed(3)}
                unit="kWh"
                color="green"
              />
              <MetricCard
                title="Current Power"
                value={pulseData.powerKw.toFixed(3)}
                unit="kW"
                color="purple"
              />
              <MetricCard
                title="Last Update"
                value={pulseData.timestamp ? new Date(pulseData.timestamp).toLocaleTimeString() : "—"}
                unit=""
                color="orange"
              />
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4" />
              <p className="text-gray-600">{loadError || "Waiting for data..."}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface MetricCardProps {
  title: string;
  value: string | number;
  unit: string;
  color: "blue" | "green" | "purple" | "orange";
}

function MetricCard({ title, value, unit, color }: MetricCardProps) {
  const colorClasses = {
    blue: "from-blue-500 to-blue-600",
    green: "from-green-500 to-green-600",
    purple: "from-purple-500 to-purple-600",
    orange: "from-orange-500 to-orange-600",
  };

  return (
    <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl p-6 border border-gray-200">
      <h3 className="text-sm font-medium text-gray-600 mb-2">{title}</h3>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold bg-gradient-to-r ${colorClasses[color]} text-transparent bg-clip-text`}>
          {value}
        </span>
        {unit && <span className="text-sm text-gray-500">{unit}</span>}
      </div>
    </div>
  );
}
