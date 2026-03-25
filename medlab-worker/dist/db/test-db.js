"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/db/test-db.ts
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log("[db:test] Initialising Prisma client...");
    await prisma.$connect();
    const result = await prisma.$queryRaw `SELECT 1 AS ok`;
    console.log("[db:test] PostgreSQL connection OK");
    console.log("[db:test] Result:", result);
}
void main()
    .catch(async (error) => {
    console.error("[db:test] PostgreSQL connection FAILED");
    console.error(error);
    try {
        await prisma.$disconnect();
    }
    catch {
        // noop
    }
    process.exit(1);
})
    .then(async () => {
    try {
        await prisma.$disconnect();
    }
    catch {
        // noop
    }
});
