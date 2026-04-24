import { DocumentType, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { DocumentPilotIngestion } from "./documentPilotIngestion";

interface CliOptions {
  cis: string;
  documentType: DocumentType;
  timeoutMs?: number;
}

const DEFAULT_CIS = "67017786";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-pilot",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  const prisma = new PrismaClient();

  try {
    const runner = new DocumentPilotIngestion(prisma, logger);
    const result = await runner.run({ cis: opts.cis, documentType: opts.documentType, fetchTimeoutMs: opts.timeoutMs });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(args: string[]): CliOptions {
  const values: Record<string, string> = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      values[arg.slice(2)] = "true";
    } else {
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }

  const cis = values.cis?.trim() || DEFAULT_CIS;
  const rawType = (values.type?.trim() || "RCP").toUpperCase();
  if (rawType !== DocumentType.RCP) {
    return { cis, documentType: rawType as DocumentType, timeoutMs: parseOptionalInt(values.timeoutMs) };
  }

  return { cis, documentType: DocumentType.RCP, timeoutMs: parseOptionalInt(values.timeoutMs) };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

main().catch((err) => {
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-pilot",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  logger.critical("run.failed", { errorCode: "PROCESS_FATAL" }, undefined, err);
  process.exitCode = 1;
});
