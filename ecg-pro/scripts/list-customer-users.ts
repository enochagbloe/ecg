import "../libs/env";
import { prisma } from "../libs/prisma";

async function main() {
  const users = await prisma.customerUser.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fullName: true,
      email: true,
      createdAt: true,
    },
  });

  if (users.length === 0) {
    console.log("No customer accounts found in the configured DATABASE_URL.");
    return;
  }

  console.table(
    users.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
    })),
  );
}

main()
  .catch((error) => {
    console.error(
      "Could not list customer accounts (" +
        (error instanceof Error ? error.name : "UnknownError") +
        ").",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
