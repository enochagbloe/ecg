import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeViewer, loginViewer, logoutViewer } from "../server/services/viewerAuthService";
import { HttpError } from "../server/utils/http";

function makeResponse() {
  const headers = new Map<string, string>();
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as ServerResponse;
  return { res, headers };
}

test("form login issues signed HttpOnly cookie accepted by the existing dashboard and Socket.IO auth", () => {
  const oldUsername = process.env.DASHBOARD_USERNAME;
  const oldPassword = process.env.DASHBOARD_PASSWORD;
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.DASHBOARD_USERNAME = "ecg-test-user";
  process.env.DASHBOARD_PASSWORD = "this-is-a-long-dashboard-test-password-2026";
  process.env.NODE_ENV = "production";
  try {
    const { res, headers } = makeResponse();
    assert.throws(
      () => loginViewer("ecg-test-user", "incorrect-password", res),
      (error: unknown) => error instanceof HttpError && error.status === 401,
    );
    assert.equal(headers.has("set-cookie"), false);

    const expiry = loginViewer("ecg-test-user", "this-is-a-long-dashboard-test-password-2026", res);
    assert.ok(expiry > Date.now());
    const cookie = headers.get("set-cookie") || "";
    assert.match(cookie, /^ecg_viewer=\d+\.[a-f0-9]{64};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=28800/);
    const request = { headers: { cookie: cookie.split(";")[0] } } as IncomingMessage;
    assert.equal(authorizeViewer(request), Number(cookie.match(/ecg_viewer=(\d+)\./)?.[1]));

    const invalid = { headers: { cookie: "ecg_viewer=1234.invalid" } } as IncomingMessage;
    assert.throws(() => authorizeViewer(invalid), (error: unknown) => error instanceof HttpError && error.status === 401);

    logoutViewer(res);
    assert.match(headers.get("set-cookie") || "", /Max-Age=0/);
  } finally {
    if (oldUsername === undefined) delete process.env.DASHBOARD_USERNAME;
    else process.env.DASHBOARD_USERNAME = oldUsername;
    if (oldPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = oldPassword;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  }
});
