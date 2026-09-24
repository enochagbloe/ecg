import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashCustomerPassword,
  verifyCustomerPassword,
} from "../server/services/customerAuthService";

test("a changed customer password invalidates the old password hash", () => {
  const oldPassword = "old-password-123";
  const newPassword = "new-password-456";

  const oldHash = hashCustomerPassword(oldPassword);
  const newHash = hashCustomerPassword(newPassword);

  assert.equal(verifyCustomerPassword(oldPassword, oldHash), true);
  assert.equal(verifyCustomerPassword(newPassword, oldHash), false);
  assert.equal(verifyCustomerPassword(newPassword, newHash), true);
  assert.equal(verifyCustomerPassword(oldPassword, newHash), false);
});
