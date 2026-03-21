// src/db/test-db.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("[db:test] Initialising Prisma client...");

  await prisma.$connect();

  const result = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;

  console.log("[db:test] PostgreSQL connection OK");
  console.log("[db:test] Result:", result);
}

void main()
  .catch(async (error: unknown) => {
    console.error("[db:test] PostgreSQL connection FAILED");
    console.error(error);

    try {
      await prisma.$disconnect();
    } catch {
      // noop
    }

    process.exit(1);
  })
  .then(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      // noop
    }
  });
