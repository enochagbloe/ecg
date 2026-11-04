"use client";

import { useId, useState } from "react";
import { Area, AreaChart, Bar, Brush, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsData, AnalyticsBucket } from "../../server/services/analyticsService";
import type { ChartMetric } from "./ConsumptionAnalytics";
import { DashboardIcon } from "./DashboardIcon";

type Point = AnalyticsBucket & { timestamp: number; reading: number | null };
const numeric = (n: number | null, digits = 3) => n == null ? "Unavailable" : n.toLocaleString(undefined, { maximumFractionDigits: digits });

export function ConsumptionChart({ data, metric, timezone, loading, onShowEnergy }: {
  data: AnalyticsData | null; metric: ChartMetric; timezone: string; loading: boolean; onShowEnergy: () => void;
}) {
  const gradientId = useId().replace(/:/g, "");
  const [zoom, setZoom] = useState<{ startIndex?: number; endIndex?: number }>({});
  const energy = metric === "energyKWh";
  // Power describes a whole bucket, so draw both boundaries. These endpoints
  // represent the bucket's extent, not additional measurements. Null buckets
  // remain null at both boundaries; no load is extrapolated across a gap.
  const points: Point[] = (data?.buckets || []).flatMap(b => {
    const point = { ...b, timestamp: Date.parse(b.start), reading: energy && b.pulseCount === 0 ? null : b[metric] };
    return energy ? [{ ...point, timestamp: (Date.parse(b.start) + Date.parse(b.end)) / 2 }]
      : [point, { ...point, timestamp: Date.parse(b.end) }];
  });
  const observed = points.filter(p => p.reading !== null);
  const visibleObserved = points.slice(zoom.startIndex ?? 0, zoom.endIndex === undefined ? undefined : zoom.endIndex + 1).filter(p => p.reading !== null);
  const hasPulses = points.some(p => p.pulseCount > 0);
  const peak = visibleObserved.length ? Math.max(...visibleObserved.map(p => p.reading!)) : null;
  const formatTick = (value: number) => new Intl.DateTimeFormat(undefined, { timeZone: timezone,
    ...(data?.resolution === "days" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit", ...(data?.resolution === "seconds" ? { second: "2-digit" } : {}) }),
  }).format(new Date(value));
  if (!data && loading) return <div className="chart-loading" role="status"><div className="chart-loading-grid" /><span>Loading recorded consumption…</span></div>;
  if (!observed.length) return <div className="chart-empty"><span className="empty-chart-icon"><DashboardIcon name="chart" /></span><h3>{hasPulses ? "Pulse energy is available" : "Your consumption story starts with a pulse"}</h3><p>{hasPulses ? "There isn’t enough reliable interval coverage to estimate this load. You can still inspect the recorded energy." : "No recorded pulses in this time range. Choose another period or check the meter connection."}</p>{hasPulses && !energy && <button className="secondary-button" type="button" onClick={onShowEnergy}>View recorded energy</button>}<span className="empty-footnote">Only actual meter readings appear here</span></div>;

  return <div className="consumption-chart" aria-label={`${energy ? "Energy in kWh" : "Electrical load in kW"} over time. Use arrow keys to inspect readings. Drag the navigator handles to zoom.`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <ComposedChart data={points} margin={{ top: 30, right: 28, left: 4, bottom: 4 }} accessibilityLayer>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-color)" stopOpacity={0.28} /><stop offset="95%" stopColor="var(--chart-color)" stopOpacity={0.025} /></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 5" />
        <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={formatTick} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={55} tickMargin={14} />
        <YAxis domain={[0, "auto"]} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={58} tickFormatter={v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 })} label={{ value: energy ? "kWh" : "kW", position: "insideTopLeft", offset: -20, fill: "var(--muted)", fontSize: 11 }} />
        <Tooltip isAnimationActive={false} cursor={{ stroke: "var(--chart-color)", strokeWidth: 1, strokeDasharray: "4 4" }} content={({ active, payload }) => {
          const point = payload?.[0]?.payload as Point | undefined;
          return active && point ? <ChartTooltip point={point} timezone={timezone} metric={metric} deviceId={data?.deviceId || ""} /> : null;
        }} />
        {peak !== null && <ReferenceLine y={peak} stroke="var(--chart-color)" strokeOpacity={.35} strokeDasharray="4 6" label={{ value: `${energy ? "Highest bucket" : "Peak"} ${numeric(peak)} ${energy ? "kWh" : "kW"}`, position: "insideTopRight", fill: "var(--muted)", fontSize: 10 }} />}
        {energy ? <Bar dataKey="reading" name="Recorded energy" fill="var(--chart-color)" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false} />
          : <Area dataKey="reading" name={metric === "peakKw" ? "Peak interval estimate" : "Average load"} type="stepAfter" stroke="var(--chart-color)" strokeWidth={2.2} fill={`url(#${gradientId})`} connectNulls={false} dot={false} activeDot={{ r: 4, fill: "var(--chart-color)", stroke: "var(--panel)", strokeWidth: 3 }} isAnimationActive={false} />}
        <Brush dataKey="timestamp" height={36} stroke="var(--chart-grid)" fill="var(--canvas)" travellerWidth={8} tickFormatter={formatTick} startIndex={zoom.startIndex} endIndex={zoom.endIndex} onChange={range => { if (range) setZoom(range); }}>
          <AreaChart data={points} accessibilityLayer={false}><Area type="stepAfter" dataKey="reading" fill="var(--tint)" stroke="var(--chart-color)" strokeWidth={1} connectNulls={false} isAnimationActive={false} /></AreaChart>
        </Brush>
      </ComposedChart>
    </ResponsiveContainer>
    <p className="chart-navigation-hint">Drag the navigator handles to explore a shorter period. Gaps indicate unavailable readings.</p>
  </div>;
}

function ChartTooltip({ point: p, timezone, metric, deviceId }: { point: Point; timezone: string; metric: ChartMetric; deviceId: string }) {
  const date = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "medium" });
  return <div className="consumption-tooltip" role="status" aria-live="polite">
    <div className="tooltip-date">{date.format(new Date(p.start))}</div><strong>{numeric(p.reading, metric === "energyKWh" ? 6 : 3)} <small>{metric === "energyKWh" ? "kWh" : "kW"}</small></strong>
    <dl><div><dt>{metric === "peakKw" ? "Bucket average" : "Peak interval estimate"}</dt><dd>{numeric(metric === "peakKw" ? p.powerKw : p.peakKw)} kW</dd></div><div><dt>Recorded energy</dt><dd>{numeric(p.energyKWh, 6)} kWh</dd></div><div><dt>Pulse count</dt><dd>{p.pulseCount}</dd></div><div><dt>Shortest interval</dt><dd>{numeric(p.intervalSeconds)} s</dd></div><div><dt>Interval coverage</dt><dd>{Math.round(p.coverage * 100)}%</dd></div></dl>
    <footer>{deviceId} · {timezone}{p.firstPulseAt && <span>First pulse {p.firstPulseAt}</span>}</footer>
  </div>;
}
