import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { bearerToken } from "../server/services/deviceAuthService";
import { authorizeViewer } from "../server/services/viewerAuthService";
import { initializeSocket } from "../server/socketServer";
import { HttpError, json, readJson } from "../server/utils/http";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP parsing enforces JSON, malformed body handling, and the 4KB limit", async () => {
  const server = createServer(async (req, res) => {
    try { json(res, 200, await readJson(req)); }
    catch (error) {
      json(res, error instanceof HttpError ? error.status : 500, { ok: false });
    }
  });
  const url = await listen(server);
  try {
    const send = (body: string, type = "application/json") => fetch(url, { method: "POST", headers: { "Content-Type": type }, body });
    assert.equal((await send('{"pulse":1}')).status, 200);
    assert.equal((await send("{")).status, 400);
    assert.equal((await send("{}","text/plain")).status, 415);
    assert.equal((await send(JSON.stringify({ body: "a".repeat(5000) }))).status, 413);
    assert.equal((await send("{}")).status, 200);
  } finally { await close(server); }
});

test("bearer authentication rejects absent and malformed headers", () => {
  for (const header of [undefined, "", "Basic foo", "Bearer ", "Bearer x y"]) {
    assert.throws(() => bearerToken(header), (error: unknown) => error instanceof HttpError && error.status === 401);
  }
  assert.equal(bearerToken("Bearer device-token"), "device-token");
});

test("dashboard cookie protects HTTP reads and Socket.io; authorized pulseData still works", { timeout: 15_000 }, async () => {
  const before = { username: process.env.DASHBOARD_USERNAME, password: process.env.DASHBOARD_PASSWORD };
  process.env.DASHBOARD_USERNAME = "test-admin";
  process.env.DASHBOARD_PASSWORD = "test-only-dashboard-secret-00000000000000000";
  const server = createServer((req, res) => {
    try { authorizeViewer(req, res); json(res, 200, { ok: true }); }
    catch (error) { json(res, error instanceof HttpError ? error.status : 500, { ok: false }); }
  });
  const socketServer = initializeSocket(server);
  const clients: Socket[] = [];
  const url = await listen(server);
  try {
    assert.equal((await fetch(url)).status, 401);
    const credentials = Buffer.from(`test-admin:${process.env.DASHBOARD_PASSWORD}`).toString("base64");
    const response = await fetch(url, { headers: { Authorization: `Basic ${credentials}` } });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Strict"));
    const cookie = setCookie.split(";")[0];
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(url, { headers: { Cookie: cookie + "bad" } })).status, 401);

    const denied = connect(url, { transports: ["websocket"], reconnection: false, timeout: 2000 });
    clients.push(denied);
    await new Promise<void>((resolve, reject) => {
      denied.once("connect_error", () => resolve());
      denied.once("connect", () => reject(new Error("Unauthorized socket connected")));
    });
    const allowed = connect(url, { transports: ["websocket"], reconnection: false, timeout: 2000, extraHeaders: { Cookie: cookie } });
    clients.push(allowed);
    await new Promise<void>((resolve, reject) => {
      allowed.once("connect", () => resolve());
      allowed.once("connect_error", reject);
    });
    const event = { deviceId: "ECG-001", pulseCount: 3, energyKWh: 3 / 1600, powerKw: 2.25, timestamp: new Date().toISOString() };
    const received = new Promise<unknown>((resolve) => allowed.once("pulseData", resolve));
    socketServer.emit("pulseData", event);
    assert.deepEqual(await received, event);
    delete process.env.DASHBOARD_PASSWORD;
    assert.equal((await fetch(url)).status, 503);
  } finally {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (server.listening) await close(server);
    for (const [key, value] of [["DASHBOARD_USERNAME", before.username], ["DASHBOARD_PASSWORD", before.password]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});