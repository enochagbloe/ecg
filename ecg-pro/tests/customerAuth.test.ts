import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCustomerSessionDurationMs,
  hashCustomerPassword,
  hashCustomerSessionToken,
  normalizeCustomerEmail,
  verifyCustomerPassword,
} from "../server/services/customerAuthService";

test("customer email normalization is stable", () => {
  assert.equal(
    normalizeCustomerEmail("  Example.User@GMAIL.COM "),
    "example.user@gmail.com",
  );
});

test("customer passwords use salted scrypt hashes", () => {
  const password = "correct-horse-battery-staple";
  const first = hashCustomerPassword(password);
  const second = hashCustomerPassword(password);

  assert.notEqual(first, password);
  assert.notEqual(first, second);
  assert.equal(first.startsWith("scrypt$"), true);
  assert.equal(verifyCustomerPassword(password, first), true);
  assert.equal(verifyCustomerPassword("wrong-password", first), false);
});

test("raw customer session tokens are not the stored representation", () => {
  const token = "example-session-token";
  const stored = hashCustomerSessionToken(token);

  assert.notEqual(stored, token);
  assert.match(stored, /^[a-f0-9]{64}$/);
});

test("customer session lifetime defaults to 30 days and validates overrides", () => {
  const previous = process.env.CUSTOMER_SESSION_DAYS;

  try {
    delete process.env.CUSTOMER_SESSION_DAYS;
    assert.equal(
      getCustomerSessionDurationMs(),
      30 * 24 * 60 * 60 * 1000,
    );

    process.env.CUSTOMER_SESSION_DAYS = "7";
    assert.equal(
      getCustomerSessionDurationMs(),
      7 * 24 * 60 * 60 * 1000,
    );

    for (const invalid of ["0", "-1", "1.5", "366", "abc"]) {
      process.env.CUSTOMER_SESSION_DAYS = invalid;
      assert.throws(() => getCustomerSessionDurationMs());
    }
  } finally {
    if (previous === undefined) delete process.env.CUSTOMER_SESSION_DAYS;
    else process.env.CUSTOMER_SESSION_DAYS = previous;
  }
});
