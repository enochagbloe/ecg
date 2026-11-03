"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AnalyticsData, AnalyticsBucket } from "../../server/services/analyticsService";
import { zonedInputToUtc } from "../../server/services/analyticsPolicy";

const periods = { Live: 300, "Last 15 minutes": 900, "Last hour": 3600, "Last 24 hours": 86400, "Last 7 days": 604800, "Last 30 days": 2592000, Custom: 0 };
const steps = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
type Resolution = keyof typeof steps;
const number = (n: number | null | undefined, digits = 3) => n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });

export default function ConsumptionAnalytics({ deviceId }: { deviceId: string }) {
  const [period, setPeriod] = useState<keyof typeof periods>("Live");
  const [resolution, setResolution] = useState<Resolution>("seconds");
  const [timezone, setTimezone] = useState("Africa/Accra");
  const [metric, setMetric] = useState<"powerKw" | "energyKWh" | "peakKw">("powerKw");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [zoom, setZoom] = useState([0, 100]);
  const [selected, setSelected] = useState<number | null>(null);
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

  const summary = data?.summary;
  const buckets = data?.buckets || [];
  const from = Math.floor(zoom[0] / 100 * Math.max(0, buckets.length - 1));
  const to = Math.max(from + 1, Math.ceil(zoom[1] / 100 * buckets.length));
  const visible = buckets.slice(from, to);
  const active = selected === null ? undefined : visible[Math.min(selected, visible.length - 1)];
  const formatTime = (value: string, exact = false) => new Intl.DateTimeFormat(undefined, { timeZone: timezone,
    ...(exact ? { dateStyle: "medium", timeStyle: "long" } : data?.resolution === "days" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit", ...(data?.resolution === "seconds" ? { second: "2-digit" } : {}) }) }).format(new Date(value));
  const max = Math.max(0.001, ...visible.map(b => b[metric] ?? 0)) * 1.1;
  const x = (i: number) => 70 + i / Math.max(1, visible.length - 1) * 860;
  const y = (v: number) => 280 - v / max * 240;
  const path = visible.map((b, i) => {
    const value = b[metric];
    if (value === null || (metric === "energyKWh" && !b.pulseCount)) return "";
    const previous = visible[i - 1];
    const command = previous && previous[metric] !== null && (metric !== "energyKWh" || previous.pulseCount > 0) ? "L" : "M";
    return `${command}${x(i)},${y(value)}`;
  }).join(" ");
  const choosePeriod = (value: keyof typeof periods) => { setPeriod(value); setZoom([0, 100]); setSelected(null); };

  return <section className="analytics" aria-labelledby="analytics-title">
    <div className="analytics-heading"><div><p className="analytics-eyebrow">RECORDED METER PULSES · {deviceId}</p><h2 id="analytics-title">Consumption analytics</h2></div>
      <span className="analytics-status">{summary?.online ? "Meter online" : "Meter offline / unknown"} · {connected ? "Live link connected" : "Live link disconnected"}</span></div>
    <div className="analytics-cards" aria-busy={loading}>
      {[
        ["Current interval estimate", `${number(summary?.currentKw)} kW`, "Unavailable after 90 seconds without a fresh pulse"],
        ["Energy today", `${number(summary?.todayKWh)} kWh`, `Calendar day · ${timezone}`],
        ["Peak interval estimate", `${number(summary?.peakIntervalKw)} kW`, `Peak bucket average: ${number(summary?.peakBucketKw)} kW`],
        ["Recorded range energy", `${number(summary?.energyKWh)} kWh`, "Unique pulses measured in the selected range"],
        ["Range average power", `${number(summary?.averageKw)} kW`, "Unavailable when interval coverage is incomplete"],
        ["Last measurement", summary?.lastPulseAt ? formatTime(summary.lastPulseAt, true) : "—", summary?.lastReceivedAt ? `Uploaded ${formatTime(summary.lastReceivedAt, true)}` : "No pulse received"],
      ].map(([title, value, note]) => <div className="analytics-card" key={title}><h3>{title}</h3><strong>{value}</strong><small>{note}</small></div>)}
    </div>
    <div className="analytics-toolbar">
      <label>Metric / calculation<select value={metric} onChange={e => setMetric(e.target.value as typeof metric)}><option value="powerKw">Power · bucket average (kW)</option><option value="peakKw">Power · peak interval estimate (kW)</option><option value="energyKWh">Energy per bucket (kWh)</option></select></label>
      <label>Time range<select value={period} onChange={e => choosePeriod(e.target.value as keyof typeof periods)}>{Object.keys(periods).map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Resolution<select value={resolution} onChange={e => { setResolution(e.target.value as Resolution); setZoom([0, 100]); }}>{Object.keys(steps).map(r => <option value={r} key={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>
      <label>Timezone<select value={timezone} onChange={e => setTimezone(e.target.value)}>{["Africa/Accra", "UTC", "Europe/London", "America/New_York", "Asia/Kolkata"].map(t => <option key={t}>{t}</option>)}</select></label>
      <button type="button" onClick={() => setTick(t => t + 1)}>Refresh</button>
    </div>
    {period === "Custom" && <div className="analytics-toolbar"><label>Start ({timezone})<input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></label><label>End ({timezone}, exclusive)<input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></label></div>}
    {error && <p role="alert" className="analytics-error">{error}</p>}
    {loading && <p role="status">{data ? "Updating recorded measurements…" : "Loading analytics…"}</p>}
    {data && <>
      {data.resolution !== resolution && <p role="status">Resolution adjusted to {data.resolution} to keep this range below 1,800 points.</p>}
      <p className="analytics-caption">{metric === "powerKw" ? "Interval-weighted bucket average (kW)" : metric === "peakKw" ? "Peak interval estimate per bucket (kW), not bucket-average power" : "Recorded energy per bucket (kWh)"} · {Math.round(data.summary.coverage * 100)}% interval coverage · {data.meterConstant} imp/kWh</p>
      {!buckets.some(b => b.pulseCount > 0) && <p role="status">No recorded pulses in this range. Consumption is unknown.</p>}
      <svg className="analytics-chart" viewBox="0 0 960 340" role="img" aria-label={`${metric !== "energyKWh" ? "Power in kW" : "Energy in kWh"} over time. Gaps indicate missing or insufficient measurements. Use arrow keys to inspect readings and zoom controls below.`}
        tabIndex={0} onPointerMove={e => { const bounds = e.currentTarget.getBoundingClientRect(); const position = (e.clientX - bounds.left) / bounds.width * 960; setSelected(Math.max(0, Math.min(visible.length - 1, Math.round((position - 70) / 860 * (visible.length - 1))))); }}
        onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setSelected(i => Math.max(0, Math.min(visible.length - 1, (i ?? 0) + (e.key === "ArrowLeft" ? -1 : 1)))); } }}>
        <title>Recorded electricity consumption</title>
        {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="70" x2="930" y1={40 + i * 60} y2={40 + i * 60} stroke="currentColor" opacity="0.12" /><text x="60" y={45 + i * 60} textAnchor="end">{number(max * (4 - i) / 4)}</text></g>)}
        <text x="70" y="22">{metric !== "energyKWh" ? "kW" : "kWh"}</text>
        <path d={path} stroke="#6366f1" fill="none" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {visible.map((b, i) => b[metric] !== null && (metric !== "energyKWh" || b.pulseCount > 0) ? <circle key={b.start} cx={x(i)} cy={y(b[metric]!)} r={visible.length < 100 ? 3 : 1.5} fill="#6366f1" /> : null)}
        {active && <line x1={x(Math.min(selected!, visible.length - 1))} x2={x(Math.min(selected!, visible.length - 1))} y1="35" y2="280" stroke="currentColor" strokeDasharray="4 4" />}
        {[0, .25, .5, .75, 1].map(f => { const i = Math.round(f * (visible.length - 1)); return visible[i] && <text key={f} x={70 + f * 860} y="310" textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{formatTime(visible[i].start)}</text>; })}
      </svg>
      <div className="analytics-inspection" aria-live="polite">{active ? <Reading bucket={active} deviceId={deviceId} formatTime={formatTime} /> : "Hover, touch, or focus the graph and use ← → to inspect a measurement."}</div>
      {data.resolution === "seconds" && <details className="analytics-pulses"><summary>Inspect individual pulses · {deviceId}</summary>
        <p className="analytics-caption">Exact recorded times (UTC). Each row contributes {number(1 / data.meterConstant, 6)} kWh. {data.pulseDetails.truncated ? "Showing only the latest 200 pulses; narrow the time range to inspect earlier events." : "All pulses in this range."}</p>
        <div className="analytics-table-scroll"><table><caption className="sr-only">Pulse-level measurements for {deviceId}</caption><thead><tr><th>Sequence</th><th>Measured (UTC)</th><th>Interval (s)</th><th>Estimate (kW)</th><th>Uploaded (UTC)</th></tr></thead><tbody>{data.pulseDetails.pulses.map(p => <tr key={p.sequence}><td>{p.sequence}</td><td>{p.timestamp}</td><td>{number(p.intervalSeconds)}</td><td>{number(p.powerKw)}</td><td>{p.receivedAt}</td></tr>)}</tbody></table></div>
      </details>}
      <div className="analytics-toolbar"><label>Zoom start<input aria-label="Zoom start percent" type="range" min="0" max={zoom[1] - 1} value={zoom[0]} onChange={e => { setZoom([+e.target.value, zoom[1]]); setSelected(null); }} /></label><label>Zoom end<input aria-label="Zoom end percent" type="range" min={zoom[0] + 1} max="100" value={zoom[1]} onChange={e => { setZoom([zoom[0], +e.target.value]); setSelected(null); }} /></label><button type="button" onClick={() => { setZoom([0, 100]); setSelected(null); }}>Reset zoom</button></div>
      <p className="analytics-caption">Power is an average between pulses, not instantaneous load. Energy counts measured pulses; empty energy buckets are gaps, not proof of zero use. Partial or unobserved power buckets remain blank. Intervals above 15 minutes are treated as uncertain. Replay updates original measurement times.</p>
      {summary && summary.unplacedPulses > 0 && <p role="status" className="analytics-error">{summary.unplacedPulses} pulses uploaded during this range have implausible clocks and cannot be placed on the chart. Stored lifetime totals are unchanged.</p>}
    </>}
  </section>;
}

function Reading({ bucket: b, deviceId, formatTime }: { bucket: AnalyticsBucket; deviceId: string; formatTime: (s: string, exact?: boolean) => string }) {
  return <><strong>{deviceId} · {formatTime(b.start, true)} – {formatTime(b.end, true)}</strong><span>Average {number(b.powerKw)} kW · Recorded {number(b.energyKWh, 6)} kWh · {b.pulseCount} pulses · Peak interval estimate {number(b.peakKw)} kW · Shortest pulse interval {number(b.intervalSeconds)} s · Coverage {Math.round(b.coverage * 100)}%</span>{b.firstPulseAt && <span>First measured pulse: {b.firstPulseAt} · {formatTime(b.firstPulseAt, true)}</span>}</>;
}
