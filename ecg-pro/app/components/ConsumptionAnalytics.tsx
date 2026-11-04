"use client";

import { useState } from "react";
import { ConsumptionChart } from "./ConsumptionChart";
import { DashboardIcon } from "./DashboardIcon";
import { periods, steps, useConsumptionAnalytics, type Resolution } from "./useConsumptionAnalytics";

const number = (n: number | null | undefined, digits = 3) => n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
const ranges = { Live: "Live", "Last 15 minutes": "15 min", "Last hour": "1 hour", "Last 24 hours": "24 hours", "Last 7 days": "7 days", "Last 30 days": "30 days", Custom: "Custom" };
export type ChartMetric = "powerKw" | "energyKWh" | "peakKw";

export default function ConsumptionAnalytics({ deviceId }: { deviceId: string }) {
  const view = useConsumptionAnalytics(deviceId);
  const { data, error, loading, timezone, period, resolution } = view;
  const [metric, setMetric] = useState<ChartMetric>("powerKw");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const summary = data?.summary;
  const energy = metric === "energyKWh";
  const time = (date: string, full = false) => new Intl.DateTimeFormat(undefined, {
    timeZone: timezone, ...(full ? { dateStyle: "medium", timeStyle: "short" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  }).format(new Date(date));
  const cards = [
    { title: "Current load", value: summary?.currentKw, unit: "kW", note: summary?.currentKw == null ? "Waiting for a fresh pulse interval" : "Estimated between the latest pulses", icon: "bolt" as const, featured: true },
    { title: "Energy today", value: summary?.todayKWh, unit: "kWh", note: `Since midnight · ${timezone}`, icon: "sun" as const },
    { title: "Energy in range", value: summary?.energyKWh, unit: "kWh", note: period === "Custom" ? "Your selected dates" : period === "Live" ? "Rolling 5-minute window" : period, icon: "meter" as const },
    { title: "Peak demand", value: summary?.peakIntervalKw, unit: "kW", note: "Highest pulse-interval estimate in range", icon: "peak" as const },
  ];

  return <section className="consumption-overview" aria-labelledby="overview-title">
    <div className="page-heading">
      <div><p className="eyebrow">YOUR ELECTRICITY, IN FOCUS</p><h1 id="overview-title">Energy overview</h1><p>See where your energy goes. Understand every change in load.</p></div>
      <div className="overview-heading-actions"><span className={`meter-status ${summary?.online ? "online" : ""}`}><span className="connection-dot" />{summary?.online ? "Meter online" : loading && !data ? "Checking meter" : "Meter offline"}</span><button className="icon-button" type="button" aria-label="Refresh readings" onClick={view.refresh}><DashboardIcon name="refresh" /></button></div>
    </div>
    <div className="overview-metrics" aria-busy={loading}>
      {cards.map(card => <article className={`overview-metric ${card.featured ? "metric-featured" : ""}`} key={card.title}>
        <div className="metric-label"><span>{card.title}</span><DashboardIcon name={card.icon} /></div>
        <div className="metric-reading"><strong>{number(card.value)}</strong><span>{card.unit}</span></div><p>{card.note}</p>
      </article>)}
    </div>
    <section className="consumption-panel" aria-labelledby="consumption-title">
      <div className="chart-panel-heading">
        <div><div className="chart-title-line"><span className="chart-heading-icon"><DashboardIcon name="chart" /></span><h2 id="consumption-title">Consumption over time</h2></div><p>{energy ? "Energy recorded in each time bucket" : metric === "peakKw" ? "Peak interval estimates reveal short-term demand" : "Average electrical load across each time bucket"}</p></div>
        <div className="metric-segment" role="group" aria-label="Chart metric"><button type="button" aria-pressed={!energy} onClick={() => setMetric("powerKw")}>Power <span>kW</span></button><button type="button" aria-pressed={energy} onClick={() => setMetric("energyKWh")}>Energy <span>kWh</span></button></div>
      </div>
      <div className="chart-controls">
        <div className="range-segment" role="group" aria-label="Time range">{(Object.keys(periods) as (keyof typeof periods)[]).map(p => <button type="button" key={p} aria-pressed={period === p} onClick={() => view.setPeriod(p)}>{p === "Live" && <span className="live-dot" />}{ranges[p]}</button>)}</div>
        <button className={`chart-settings-button ${settingsOpen ? "selected" : ""}`} type="button" aria-expanded={settingsOpen} aria-controls="chart-settings" onClick={() => setSettingsOpen(v => !v)}><DashboardIcon name="settings" />View settings</button>
      </div>
      {(settingsOpen || period === "Custom") && <div className="chart-settings" id="chart-settings">
        <label>Resolution<select value={resolution} onChange={e => view.setResolution(e.target.value as Resolution)}>{Object.keys(steps).map(r => <option value={r} key={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>
        <label>Timezone<select value={timezone} onChange={e => view.setTimezone(e.target.value)}>{["Africa/Accra", "UTC", "Europe/London", "America/New_York", "Asia/Kolkata"].map(t => <option key={t}>{t}</option>)}</select></label>
        {!energy && <label>Power calculation<select value={metric} onChange={e => setMetric(e.target.value as ChartMetric)}><option value="powerKw">Bucket average</option><option value="peakKw">Peak pulse interval</option></select></label>}
        {period === "Custom" && <><label>Start · {timezone}<input type="datetime-local" value={view.start} onChange={e => view.setStart(e.target.value)} /></label><label>End · {timezone}<input type="datetime-local" value={view.end} onChange={e => view.setEnd(e.target.value)} /></label></>}
      </div>}
      <div className="chart-context"><span className="chart-series-key"><i />{energy ? "Recorded energy" : metric === "peakKw" ? "Peak interval power" : "Average load"}<span className="context-divider">/</span>{data?.resolution || resolution}</span><span>{timezone}<span className="context-divider">·</span>{loading ? <span role="status">Updating…</span> : data ? "Readings up to date" : "Awaiting readings"}</span></div>
      {data && data.resolution !== resolution && <p className="resolution-notice" role="status">Showing {data.resolution} for this range to keep the graph readable.</p>}
      {error ? <div className="chart-empty error" role="alert"><DashboardIcon name="signal" /><h3>Readings couldn’t be loaded</h3><p>{error}</p><button type="button" className="secondary-button" onClick={view.refresh}>Try again</button></div>
        : <ConsumptionChart key={`${period}-${resolution}-${timezone}-${metric}`} data={data} metric={metric} timezone={timezone} loading={loading} onShowEnergy={() => setMetric("energyKWh")} />}
      <div className="chart-bottom-strip">
        <div><span>Range average</span><strong>{number(summary?.averageKw)} <small>kW</small></strong></div>
        <div><span>Peak bucket average</span><strong>{number(summary?.peakBucketKw)} <small>kW</small></strong></div>
        <div><span>Interval coverage</span><strong>{summary ? Math.round(summary.coverage * 100) : "—"}<small> %</small></strong></div>
        <div className="last-reading"><span>Last measured pulse</span><strong>{summary?.lastPulseAt ? time(summary.lastPulseAt) : "Awaiting data"}</strong></div>
      </div>
    </section>
    <div className="overview-detail-row">
      <div className="measurement-note"><DashboardIcon name="signal" /><div><strong>Measured from your meter</strong><p>{data ? `${data.meterConstant.toLocaleString()} imp/kWh · ${deviceId}` : deviceId} · Gaps remain visible when readings are unavailable.</p></div></div>
      {summary?.lastReceivedAt && <span className="last-upload">Last upload {time(summary.lastReceivedAt, true)}</span>}
    </div>
    {summary && summary.unplacedPulses > 0 && <p role="status" className="analytics-error">{summary.unplacedPulses} uploaded pulses have unreliable timestamps and are excluded from the chart.</p>}
    {data?.resolution === "seconds" && <details className="pulse-explorer"><summary><span><DashboardIcon name="meter" />Pulse explorer<small>Original measurements and upload times</small></span><span>{data.pulseDetails.pulses.length}{data.pulseDetails.truncated ? "+" : ""} pulses<span aria-hidden="true"> ＋</span></span></summary>
      <div className="pulse-explorer-content"><p>{data.pulseDetails.truncated ? "Latest 200 pulses shown. Narrow the range to inspect earlier measurements." : "All recorded pulses in this range."} Each pulse contributes {number(1 / data.meterConstant, 6)} kWh. Times below are UTC.</p>
        <div className="analytics-table-scroll"><table><caption className="sr-only">Pulse measurements for {deviceId}</caption><thead><tr><th>Sequence</th><th>Measured at (UTC)</th><th>Interval</th><th>Estimated load</th><th>Uploaded at (UTC)</th></tr></thead><tbody>{data.pulseDetails.pulses.map(p => <tr key={p.sequence}><td>{p.sequence}</td><td>{p.timestamp}</td><td>{number(p.intervalSeconds)} s</td><td>{number(p.powerKw)} kW</td><td>{p.receivedAt}</td></tr>)}</tbody></table></div>
      </div>
    </details>}
    <details className="calculation-note"><summary>About these readings</summary><p>Power estimates describe the average load between optical meter pulses. Bucket averages distribute interval energy across time boundaries. Partial coverage, invalid clocks and intervals over 15 minutes remain unestimated. Energy shows recorded pulses; missing readings do not prove zero consumption. Offline replay appears at its original measurement time.</p></details>
  </section>;
}
