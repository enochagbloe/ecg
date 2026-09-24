import "../libs/env";
import { stdin as input, stdout as output } from "node:process";
import { prisma } from "../libs/prisma";
import {
  hashCustomerPassword,
  normalizeCustomerEmail,
} from "../server/services/customerAuthService";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("This command requires an interactive terminal."));
      return;
    }

    output.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      output.write("\n");
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          process.exit(130);
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= " ") {
          value += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function main() {
  const rawEmail = process.argv[2];
  if (!rawEmail) {
    throw new Error(
      "Usage: pnpm users:set-password -- customer@example.com",
    );
  }

  const email = normalizeCustomerEmail(rawEmail);
  const user = await prisma.customerUser.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error("No customer account exists for that email.");
  }

  const password = await readHidden("New password: ");
  const confirm = await readHidden("Confirm new password: ");

  if (password.length < 8 || password.length > 128) {
    throw new Error("Password must be 8-128 characters.");
  }

  if (password !== confirm) {
    throw new Error("Passwords do not match.");
  }

  await prisma.$transaction([
    prisma.customerUser.update({
      where: { id: user.id },
      data: { passwordHash: hashCustomerPassword(password) },
    }),
    prisma.customerSession.deleteMany({
      where: { userId: user.id },
    }),
  ]);

  console.log(
    "Password changed and all existing sessions revoked for " + user.email,
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Password reset failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
