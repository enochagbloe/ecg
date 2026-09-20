import "../libs/env";

async function main() {
  const deviceId = process.argv[2] || process.env.BOOTSTRAP_DEVICE_ID;
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!deviceId || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error("Supply a device ID argument or BOOTSTRAP_DEVICE_ID.");
  if (!username || !password) throw new Error("Configure DASHBOARD_USERNAME and DASHBOARD_PASSWORD in .env.local.");
  const base = new URL(process.env.RESET_API_URL || "http://localhost:3000");
  if (base.username || base.password || (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("Reset URL must use HTTPS or local loopback HTTP, without embedded credentials.");
  }
  const url = new URL(`/api/v1/devices/${encodeURIComponent(deviceId)}/reset-test-data`, base);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, "X-ECG-Test-Reset": "true" },
    });
  } catch {
    throw new Error("Reset request failed. Check that the backend is running and RESET_API_URL is correct.");
  }
  if (!response.ok) throw new Error(`Reset failed (HTTP ${response.status}). Check dashboard credentials, device ID, and production reset flag.`);
  console.log(`${deviceId} test history cleared; connected dashboards notified.`);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Reset failed");
  process.exitCode = 1;
});