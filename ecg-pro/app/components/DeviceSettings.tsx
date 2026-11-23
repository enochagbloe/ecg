"use client";
import { useEffect, useState } from "react";
type Settings = {
  deviceId: string;
  name: string | null;
  active: boolean;
  online: boolean;
  lastSeenAt: string | null;
  firmwareVersion: string | null;
  resetSupported: boolean;
  meterConstant: number;
  totalPulses: number;
  pending: {
    requestId: string;
    meterConstant: number;
    label: string;
    requestedAt: string;
    resetReady: boolean;
  } | null;
  history: {
    id: string;
    label: string;
    meterConstant: number;
    startSequence: string;
    effectiveAt: string;
    resetConfirmed: boolean;
  }[];
};
const date = (v: string | null) =>
  v
    ? new Date(v).toLocaleString(undefined, { timeZone: "Africa/Accra" })
    : "Not reported";
export default function DeviceSettings({ deviceId }: { deviceId: string }) {
  const [data, setData] = useState<Settings | null>(null),
    [name, setName] = useState(""),
    [constant, setConstant] = useState(""),
    [label, setLabel] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const url = `/api/v1/devices/${encodeURIComponent(deviceId)}/settings`;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const r = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!r.ok) throw Error(`Unable to load settings (HTTP ${r.status})`);
        const d: Settings = await r.json();
        if (active) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (active && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load settings");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [url]);
  async function save(body: unknown, message: string) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "Unable to save settings");
      const refreshed = await fetch(url, { cache: "no-store" });
      if (!refreshed.ok)
        throw Error("Saved; refresh to see the latest settings");
      setData(await refreshed.json());
      setNotice(message);
      setConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save settings");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="device-settings">
      <div className="page-heading">
        <div>
          <p className="eyebrow">DEVICE WORKSPACE</p>
          <h1>Device settings</h1>
          <p>Manage your device and preserve every meter's history.</p>
        </div>
        <span className="device-tag">{deviceId}</span>
      </div>
      {error && (
        <p role="alert" className="analytics-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">Loading settings...</p>
      ) : (
        <>
          <div className="settings-grid">
            <section className="settings-card">
              <h2>Device identity</h2>
              <dl>
                <div>
                  <dt>Device ID</dt>
                  <dd>{data.deviceId}</dd>
                </div>
                <div>
                  <dt>Firmware</dt>
                  <dd>{data.firmwareVersion || "Not reported"}</dd>
                </div>
                <div>
                  <dt>Device name</dt>
                  <dd>{data.name || "Unnamed device"}</dd>
                </div>
              </dl>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({ action: "rename", name }, "Device name saved.");
                }}
              >
                <label htmlFor="device-name">New device name</label>
                <input
                  id="device-name"
                  value={name}
                  maxLength={120}
                  required
                  onChange={(e) => setName(e.target.value)}
                  placeholder={data.name || "e.g. Main building"}
                />
                <button
                  disabled={busy || !name.trim()}
                  className="secondary-button"
                >
                  Save name
                </button>
              </form>
            </section>
            <section className="settings-card">
              <h2>Device health</h2>
              <p className="settings-health">
                <span
                  className={
                    data.online ? "connection-dot connected" : "connection-dot"
                  }
                />
                {!data.active ? "Disabled" : data.online ? "Online" : "Offline"}
              </p>
              <dl>
                <div>
                  <dt>Last seen - Accra</dt>
                  <dd>{date(data.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt>Stored pulses</dt>
                  <dd>{data.totalPulses.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Active meter constant</dt>
                  <dd>
                    <strong>
                      {data.meterConstant.toLocaleString()} IMP/kWh
                    </strong>
                  </dd>
                </div>
              </dl>
              <p>
                Open Diagnostics to inspect sensor readings and rejected
                flashes. Online status confirms recent contact, not counting
                accuracy.
              </p>
            </section>
          </div>
          <section className="settings-card">
            <h2>Change meter configuration</h2>
            <p>
              Your account, pulse records and previous usage stay saved. Each
              meter keeps its own IMP/kWh value.
            </p>
            {!data.resetSupported && (
              <p role="status" className="settings-notice">
                This device needs reset-aware firmware before a meter change can
                be activated.
              </p>
            )}
            {data.pending ? (
              <div className="settings-pending" role="status">
                <h3>
                  {data.pending.resetReady
                    ? "Ready for device reset"
                    : "Waiting for device to acknowledge the change"}
                </h3>
                <p>
                  {data.pending.label} -{" "}
                  {data.pending.meterConstant.toLocaleString()} IMP/kWh
                  requested {date(data.pending.requestedAt)}.
                </p>
                <p>
                  Stop the test flashes or remove the sensor from the meter LED.
                  Wait until this page says Ready for device reset, let
                  pending uploads finish, then press the device's RESET button.
                  Keep the sensor away from flashes until this page shows the
                  new configuration. Reattach it to the new meter afterwards.
                </p>
                <p>
                  The current configuration stays active until the backend
                  confirms the restart. Never erase device storage.
                </p>
                <button
                  disabled={busy}
                  className="secondary-button"
                  onClick={() =>
                    void save(
                      { action: "cancel", requestId: data.pending!.requestId },
                      "Pending meter change cancelled.",
                    )
                  }
                >
                  Cancel pending change
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(
                    {
                      action: "request",
                      meterConstant: Number(constant),
                      label,
                      confirm: confirmed,
                    },
                    "Meter change requested. Follow the reset instructions below.",
                  );
                }}
              >
                <div className="settings-fields">
                  <div>
                    <label htmlFor="meter-label">Meter name or reference</label>
                    <input
                      id="meter-label"
                      required
                      value={label}
                      maxLength={120}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="e.g. Replacement meter"
                    />
                  </div>
                  <div>
                    <label htmlFor="meter-constant">
                      IMP/kWh printed on meter
                    </label>
                    <input
                      id="meter-constant"
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      required
                      value={constant}
                      onChange={(e) => setConstant(e.target.value)}
                      placeholder="e.g. 1000, 1005 or 1006"
                    />
                  </div>
                </div>
                <label className="settings-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I will stop flashes, allow uploads to finish and reset the
                  device before using the new meter.
                </label>
                <button
                  className="secondary-button"
                  disabled={busy || !confirmed || !data.resetSupported}
                >
                  Request meter change
                </button>
              </form>
            )}
          </section>
          <section className="settings-card">
            <h2>Meter history</h2>
            <p>
              Dates below use Africa/Accra. Imported history retains the
              previous configuration; its original activation date may be
              unknown.
            </p>
            <div className="analytics-table-scroll">
              <table>
                <caption className="sr-only">
                  Meter configuration history
                </caption>
                <thead>
                  <tr>
                    <th>Meter</th>
                    <th>IMP/kWh</th>
                    <th>Effective date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h, i) => (
                    <tr key={h.id}>
                      <td>{h.label}</td>
                      <td>{h.meterConstant.toLocaleString()}</td>
                      <td>{h.resetConfirmed ? date(h.effectiveAt) : "Original date unknown"}</td>
                      <td>
                        {i === 0 ? "Active" : "Previous"} -{" "}
                        {h.resetConfirmed
                          ? "Reset confirmed"
                          : "Original configuration"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.history.length && <p>No meter changes recorded.</p>}
          </section>
        </>
      )}
    </section>
  );
}
