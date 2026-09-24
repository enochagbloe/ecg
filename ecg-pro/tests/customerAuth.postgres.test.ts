import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  authenticateCustomerToken,
  createCustomerSession,
  hashCustomerPassword,
  hashCustomerSessionToken,
  revokeCustomerSession,
} from "../server/services/customerAuthService";

test(
  "PostgreSQL: customer sessions persist, revoke independently, and reject expiry",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL! } },
    });

    const marker = randomBytes(10).toString("hex");
    const email = "auth-" + marker + "@example.test";

    const user = await db.customerUser.create({
      data: {
        fullName: "Auth Test",
        email,
        passwordHash: hashCustomerPassword("test-password-123"),
      },
    });

    try {
      const first = await createCustomerSession(user.id, db);
      const second = await createCustomerSession(user.id, db);

      const storedFirst = await db.customerSession.findUniqueOrThrow({
        where: { tokenHash: hashCustomerSessionToken(first.token) },
      });

      assert.notEqual(storedFirst.tokenHash, first.token);
      assert.equal(
        (await authenticateCustomerToken(first.token, db)).user.id,
        user.id,
      );
      assert.equal(
        (await authenticateCustomerToken(second.token, db)).user.id,
        user.id,
      );

      await revokeCustomerSession(first.token, db);
      await assert.rejects(authenticateCustomerToken(first.token, db));

      assert.equal(
        (await authenticateCustomerToken(second.token, db)).user.id,
        user.id,
      );

      const expiredToken = randomBytes(32).toString("base64url");

      await db.customerSession.create({
        data: {
          userId: user.id,
          tokenHash: hashCustomerSessionToken(expiredToken),
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      await assert.rejects(authenticateCustomerToken(expiredToken, db));

      assert.equal(
        await db.customerSession.count({
          where: { tokenHash: hashCustomerSessionToken(expiredToken) },
        }),
        0,
      );
    } finally {
      await db.customerUser.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
