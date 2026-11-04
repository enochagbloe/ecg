"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import Link from "next/link";

import { createMeterUpdates, type PulseData } from "./meterUpdates";
import OpticalDiagnostics from "./OpticalDiagnostics";
import ConsumptionAnalytics from "./ConsumptionAnalytics";

export default function ECGMonitor() {
  const [tab, setTab] = useState<"overview" | "diagnostics">("overview");
  const [pulseData, setPulseData] = useState<PulseData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const deviceId = process.env.NEXT_PUBLIC_DEVICE_ID || "ECG-001";
    const controller = new AbortController();
    let active = true;
    const updates = createMeterUpdates(deviceId, (data) => {
      if (!active) return;
      setPulseData(data);
      setLoadError(null);
    });
    const loadState = async () => {
      const token = updates.beginSnapshot();
      try {
        const response = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/state`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Unable to load meter state (HTTP ${response.status}).`);
        const state: { deviceId: string; totalPulses: number; lastPulseAt: string | null; energyKWh: number; powerKw: number } = await response.json();
        if (!active) return;
        updates.snapshot(token, { deviceId: state.deviceId, pulseCount: state.totalPulses, timestamp: state.lastPulseAt,
          energyKWh: state.energyKWh, powerKw: state.powerKw });
      } catch (error) {
        if (active && !controller.signal.aborted && updates.isCurrent(token)) setLoadError(error instanceof Error ? error.message : "Unable to load meter state.");
      }
    };
    const socketInstance = io({ transports: ["websocket"], withCredentials: true });
    socketInstance.on("connect", () => {
      setIsConnected(true);
      void loadState();
    });
    socketInstance.on("disconnect", () => setIsConnected(false));
    socketInstance.on("connect_error", () => setIsConnected(false));
    socketInstance.on("pulseData", updates.pulse);
    socketInstance.on("deviceReset", updates.reset);
    void loadState();
    return () => {
      active = false;
      controller.abort();
      socketInstance.disconnect();
    };
  }, []);

  const deviceId = process.env.NEXT_PUBLIC_DEVICE_ID || "ECG-001";
  return (
    <div className="monitor-app">
      <header className="monitor-header">
        <Link className="monitor-brand" href="/" aria-label="GridLoRa home">
          <span className="brand-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 2 5 13h6l-1 9 9-13h-6l1-7Z" fill="currentColor" /></svg></span>
          <span>GridLoRa<span className="brand-divider">/</span><span className="brand-product">Energy intelligence</span></span>
        </Link>
        <div className="header-device"><span className={isConnected ? "connection-dot connected" : "connection-dot"} />{isConnected ? "Live connection" : "Reconnecting"}<span className="device-tag">{deviceId}</span></div>
      </header>
      <nav className="monitor-tabs" role="tablist" aria-label="Dashboard sections" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "overview" : event.key === "End" ? "diagnostics" : tab === "overview" ? "diagnostics" : "overview";
        setTab(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus();
      }}>
        <button id="overview-tab" role="tab" tabIndex={tab === "overview" ? 0 : -1} aria-selected={tab === "overview"} aria-controls="overview-panel" onClick={() => setTab("overview")}>Overview</button>
        <button id="diagnostics-tab" role="tab" tabIndex={tab === "diagnostics" ? 0 : -1} aria-selected={tab === "diagnostics"} aria-controls="diagnostics-panel" onClick={() => setTab("diagnostics")}>Diagnostics</button>
      </nav>
      <main className="monitor-main">
        <div id="overview-panel" role="tabpanel" aria-labelledby="overview-tab" hidden={tab !== "overview"}>
          <ConsumptionAnalytics deviceId={deviceId} />
        </div>
        <div id="diagnostics-panel" role="tabpanel" aria-labelledby="diagnostics-tab" hidden={tab !== "diagnostics"}>
          <div className="page-heading"><div><p className="eyebrow">DEVICE WORKSPACE</p><h1>Meter diagnostics</h1><p>Sensor health, pulse delivery and connection details.</p></div><span className="device-tag">{deviceId}</span></div>
          <div className="device-health-strip">
            <div><span>Stored pulses</span><strong>{pulseData?.pulseCount.toLocaleString() ?? "—"}</strong></div>
            <div><span>Lifetime energy</span><strong>{pulseData ? pulseData.energyKWh.toFixed(3) + " kWh" : "—"}</strong></div>
            <div><span>Last measured pulse</span><strong>{pulseData?.timestamp ? new Date(pulseData.timestamp).toLocaleString(undefined, { timeZone: "Africa/Accra" }) : "No measurement"}</strong></div>
          </div>
          {loadError && <p role="alert" className="analytics-error">{loadError}</p>}
          <OpticalDiagnostics deviceId={deviceId} />
        </div>
      </main>
      <footer className="monitor-footer"><span>GridLoRa · Electricity monitoring</span><span>Measured with optical meter pulses</span></footer>
    </div>
  );
}
