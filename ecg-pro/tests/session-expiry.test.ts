import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleSessionExpiry } from "../server/utils/sessionExpiry";

test("30-day socket sessions remain connected until actual expiry", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let expired = 0;
  const duration = 30 * 24 * 60 * 60 * 1000;
  scheduleSessionExpiry(Date.now() + duration, () => expired++);
  context.mock.timers.tick(2_147_483_647);
  assert.equal(expired, 0);
  context.mock.timers.tick(duration - 2_147_483_647 - 1);
  assert.equal(expired, 0);
  context.mock.timers.tick(1);
  assert.equal(expired, 1);
});

test("disconnect cancels the session timer", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let expired = false;
  const cancel = scheduleSessionExpiry(Date.now() + 1000, () => { expired = true; });
  cancel();
  context.mock.timers.tick(2000);
  assert.equal(expired, false);
});

test("expired and invalid deadlines disconnect immediately", () => {
  for (const deadline of [Date.now() - 1, Number.NaN]) {
    let expired = false;
    scheduleSessionExpiry(deadline, () => { expired = true; });
    assert.equal(expired, true);
  }
});
