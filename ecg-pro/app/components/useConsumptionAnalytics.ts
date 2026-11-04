"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AnalyticsData } from "../../server/services/analyticsService";
import { zonedInputToUtc } from "../../server/services/analyticsPolicy";

export const periods = { Live: 300, "Last 15 minutes": 900, "Last hour": 3600, "Last 24 hours": 86400, "Last 7 days": 604800, "Last 30 days": 2592000, Custom: 0 };
export const steps = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export type Resolution = keyof typeof steps;
export function useConsumptionAnalytics(deviceId: string) {
  const [period, setPeriod] = useState<keyof typeof periods>("Last 24 hours");
  const [resolution, setResolution] = useState<Resolution>("minutes");
  const [timezone, setTimezone] = useState("Africa/Accra");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const fetching = useRef(false);

  useEffect(() => {
    let queued: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (queued || fetching.current) return;
      queued = setTimeout(() => { queued = undefined; setTick(t => t + 1); }, 1000);
    };
    const socket = io({ transports: ["websocket"], withCredentials: true });
    socket.on("connect", () => { setConnected(true); refresh(); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));
    const event = (e: { deviceId: string }) => { if (e.deviceId === deviceId) refresh(); };
    socket.on("pulseData", event);
    socket.on("deviceReset", event);
    const polling = setInterval(refresh, 15000); // Heartbeats do not broadcast; also reconciles missed/replayed events.
    return () => { socket.disconnect(); clearInterval(polling); clearTimeout(queued); };
  }, [deviceId]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      fetching.current = true;
      setLoading(true);
      try {
        const finish = period === "Custom" ? zonedInputToUtc(end, timezone) : new Date().toISOString();
        const begin = period === "Custom" ? zonedInputToUtc(start, timezone) : new Date(Date.parse(finish) - periods[period] * 1000).toISOString();
        const duration = (Date.parse(finish) - Date.parse(begin)) / 1000;
        if (!(duration > 0) || duration > 366 * 86400) throw new Error("Choose a start before the end, within 366 days.");
        const effective = (Object.keys(steps) as Resolution[]).find(r => steps[r] >= steps[resolution] && Math.ceil(duration / steps[r]) + 2 <= 1800) || "days";
        const params = new URLSearchParams({ start: begin, end: finish, resolution: effective, timezone });
        const response = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/analytics?${params}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to load analytics.");
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : "Unable to load analytics."); setData(null); }
      } finally { if (!controller.signal.aborted) { fetching.current = false; setLoading(false); } }
    };
    void load();
    return () => { controller.abort(); fetching.current = false; };
  }, [deviceId, period, resolution, start, end, timezone, tick]);

  return { period, setPeriod, resolution, setResolution, timezone, setTimezone,
    start, setStart, end, setEnd, data, error, loading, connected,
    refresh: () => setTick(t => t + 1) };
}
