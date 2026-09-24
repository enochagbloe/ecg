import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../libs/prisma";
import {
  authorizeCustomer,
  createCustomerSession,
  customerBearerToken,
  hashCustomerPassword,
  normalizeCustomerEmail,
  revokeCustomerSession,
  verifyCustomerPassword,
} from "../services/customerAuthService";
import { HttpError, json, readJson } from "../utils/http";

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform(normalizeCustomerEmail);

const passwordSchema = z.string().min(8).max(128);

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
}).strict();

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
}).strict();

function publicUser(user: { id: string; fullName: string; email: string }) {
  return { id: user.id, fullName: user.fullName, email: user.email };
}

export async function customerRegister(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const parsed = registerSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(
      400,
      "Expected fullName, valid email, and password of 8-128 characters",
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.customerUser.findUnique({
        where: { email: parsed.data.email },
        select: { id: true },
      });

      if (existing) {
        throw new HttpError(409, "An account with this email already exists");
      }

      const user = await tx.customerUser.create({
        data: {
          fullName: parsed.data.fullName,
          email: parsed.data.email,
          passwordHash: hashCustomerPassword(parsed.data.password),
        },
      });

      const session = await createCustomerSession(user.id, tx);

      return {
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        user: publicUser(user),
      };
    });

    json(res, 201, result);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new HttpError(409, "An account with this email already exists");
    }
    throw error;
  }
}

export async function customerLogin(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const parsed = loginSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    throw new HttpError(400, "Expected valid email and password");
  }

  const user = await prisma.customerUser.findUnique({
    where: { email: parsed.data.email },
  });

  if (!user || !verifyCustomerPassword(parsed.data.password, user.passwordHash)) {
    throw new HttpError(401, "Invalid email or password");
  }

  const session = await createCustomerSession(user.id);

  json(res, 200, {
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
    user: publicUser(user),
  });
}

export async function customerChangePassword(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  const parsed = z.object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  }).strict().safeParse(await readJson(req));

  if (!parsed.success) {
    throw new HttpError(
      400,
      "Expected currentPassword and newPassword of 8-128 characters",
    );
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    throw new HttpError(
      400,
      "New password must be different from current password",
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.customerUser.findUnique({
      where: { id: auth.user.id },
    });

    if (
      !user ||
      !verifyCustomerPassword(
        parsed.data.currentPassword,
        user.passwordHash,
      )
    ) {
      throw new HttpError(401, "Current password is incorrect");
    }

    const updated = await tx.customerUser.update({
      where: { id: user.id },
      data: {
        passwordHash: hashCustomerPassword(parsed.data.newPassword),
      },
    });

    // Revoke every old session after a password change. A fresh session is
    // created below so the device performing the change remains signed in.
    await tx.customerSession.deleteMany({
      where: { userId: user.id },
    });

    const session = await createCustomerSession(user.id, tx);

    return {
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: publicUser(updated),
    };
  });

  json(res, 200, result);
}

export async function customerMe(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") throw new HttpError(405, "Method not allowed");

  const auth = await authorizeCustomer(req);
  json(res, 200, {
    user: publicUser(auth.user),
    expiresAt: auth.expiresAt.toISOString(),
  });
}

export async function customerLogout(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const token = customerBearerToken(req.headers.authorization);
  await revokeCustomerSession(token);
  json(res, 200, { ok: true });
}

export async function customerForgotPassword(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

  const parsed = z.object({ email: emailSchema }).strict().safeParse(
    await readJson(req),
  );

  if (!parsed.success) throw new HttpError(400, "Expected valid email");

  throw new HttpError(
    501,
    "Password recovery delivery is not configured yet",
  );
}
