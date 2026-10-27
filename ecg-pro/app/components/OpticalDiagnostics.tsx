"use client";

import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

interface OpticalLog {
  deviceId: string;
  receivedAt: string;
  diagnosticOnly: boolean;
  minimum: number;
  maximum: number;
  baseline: number;
  peakDelta: number;
  onDelta: number;
  offDelta: number;
  samples: number;
  candidates: number;
  detected: number;
  shortRejected: number;
  widthSamples?: number;
  minWidthUs?: number;
  maxWidthUs?: number;
  averageWidthUs?: number;
  lastWidthUs?: number;
  maxShortWidthUs?: number;
  longRejected: number;
  saturatedSamples: number;
  queueDrops: number;
  armed: boolean;
}

export default function OpticalDiagnostics({ deviceId }: { deviceId: string }) {
  const [logs, setLogs] = useState<OpticalLog[]>([]);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const apply = (entry: OpticalLog) => {
      if (!mounted || entry.deviceId !== deviceId) return;
      setLogs((current) => {
        if (current.some((item) => item.receivedAt === entry.receivedAt)) return current;
        return [...current, entry].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-60);
      });
    };
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/diagnostics`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Diagnostics unavailable (HTTP ${response.status})`);
        const data: { logs: OpticalLog[] } = await response.json();
        if (mounted) {
          setLogs((current) => {
            const map = new Map([...data.logs, ...current].map((entry) => [entry.receivedAt, entry]));
            return [...map.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-60);
          });
          setError("");
        }
      } catch (caught) {
        if (mounted && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Diagnostics unavailable");
      }
    };
    const socket = io({ transports: ["websocket"], withCredentials: true });
    socket.on("connect", () => { setConnected(true); void load(); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    socket.on("opticalDiagnostic", apply);
    void load();
    return () => { mounted = false; controller.abort(); socket.disconnect(); };
  }, [deviceId]);

  const latest = logs.at(-1);
  const window = useMemo(() => logs.slice(-12).reverse(), [logs]);
  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Optical sensor diagnostics</h2>
          <p className="text-xs text-slate-600">
            TEPT4400 • {deviceId} • last 60 reports (server memory only)
          </p>
        </div>
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs">
          {connected ? "Live feed connected" : "Live feed disconnected"}
        </span>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-amber-800">{error}</p>}
      {latest ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-white px-2 py-1">{latest.diagnosticOnly ? "DIAGNOSTIC ONLY — no pulse uploads" : "LIVE COUNTING"}</span>
            <span className="rounded bg-white px-2 py-1">Received {new Date(latest.receivedAt).toLocaleTimeString()}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Peak ADC", latest.maximum],
              ["Ambient baseline", latest.baseline],
              ["Detection threshold", latest.baseline + latest.onDelta],
              ["Accepted / 5s", latest.detected],
              ["Candidates / 5s", latest.candidates],
              ["Too short / 5s", latest.shortRejected],
              ["ADC samples / 5s", latest.samples],
              ["Saturated samples", latest.saturatedSamples],
            ].map(([name, value]) => (
              <div key={name} className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs text-slate-500">{name}</p>
                <p className="mt-1 text-xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <h3 className="mt-6 mb-2 text-sm font-semibold">Measured pulse durations (microseconds)</h3>
          {latest.widthSamples === undefined ? (
            <p className="mb-3 text-sm text-slate-500">Upload the pulse-width diagnostic firmware to see durations.</p>
          ) : (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Last waveform", latest.widthSamples ? latest.lastWidthUs : "—"],
                ["Average waveform", latest.widthSamples ? latest.averageWidthUs : "—"],
                ["Shortest / longest", latest.widthSamples ? `${latest.minWidthUs}–${latest.maxWidthUs}` : "—"],
                ["Longest rejected short", latest.shortRejected ? latest.maxShortWidthUs : "—"],
              ].map(([name, value]) => (
                <div key={name} className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-xs text-slate-500">{name} (µs)</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </div>
              ))}
            </div>
          )}
          <h3 className="mt-6 mb-2 text-sm font-semibold">Recent 5-second reports</h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-slate-100">
                <tr>{["Received", "ADC range", "Baseline", "Candidates", "Detected", "Short", "Width µs", "Long"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
              </thead>
              <tbody>
                {window.map((row) => (
                  <tr key={row.receivedAt} className="border-t border-slate-100">
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(row.receivedAt).toLocaleTimeString()}</td>
                    <td className="px-3 py-2">{row.minimum}–{row.maximum}</td>
                    <td className="px-3 py-2">{row.baseline}</td>
                    <td className="px-3 py-2">{row.candidates}</td>
                    <td className="px-3 py-2 font-semibold">{row.detected}</td>
                    <td className="px-3 py-2">{row.shortRejected}</td>
                    <td className="px-3 py-2">{row.widthSamples === undefined ? "—" : row.widthSamples ? `${row.minWidthUs}–${row.maxWidthUs}` : "none"}</td>
                    <td className="px-3 py-2">{row.longRejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p className="text-sm text-slate-600">No remote sensor reports yet. Connect the updated ESP32 to Wi-Fi to begin.</p>}
      <p className="mt-3 text-xs text-slate-500">
        Diagnostics never create electricity pulse events. History is temporary and resets with the Render service.
      </p>
    </section>
  );
}
