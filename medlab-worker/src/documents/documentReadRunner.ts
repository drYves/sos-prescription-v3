import { DocumentType, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { DocumentReader } from "./documentReader";

interface CliOptions {
  cis: string;
  documentType: DocumentType;
  includeContent: boolean;
  previewChars?: number;
}

const DEFAULT_CIS = "67017786";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-read",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  const prisma = new PrismaClient();

  logger.info("document.read.started", {
    cis: opts.cis,
    documentType: opts.documentType,
    includeContent: opts.includeContent,
    previewChars: opts.previewChars,
  });

  try {
    const reader = new DocumentReader(prisma);
    const result = await reader.read({
      cis: opts.cis,
      documentType: opts.documentType,
      includeContent: opts.includeContent,
      previewChars: opts.previewChars,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    if (result.ok) {
      logger.info("document.read.completed", {
        cis: result.cis,
        documentType: result.documentType,
        status: result.current?.status,
        versionId: result.version?.id,
        assessmentStatus: result.assessment?.status,
      });
    } else {
      logger.warning("document.read.failed", {
        cis: result.cis,
        documentType: result.documentType,
        errorCode: result.errorCode,
        status: result.current?.status,
        assessmentStatus: result.assessment?.status,
      });
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

  return {
    cis,
    documentType: rawType as DocumentType,
    includeContent: parseBoolean(values.includeContent),
    previewChars: parsePreviewChars(values.previewChars),
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parsePreviewChars(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed <= 0) return 800;
  return Math.min(parsed, 5000);
}

main().catch((err) => {
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-read",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  logger.error("document.read.failed", { errorCode: "PROCESS_FATAL" }, undefined, err);
  process.exitCode = 1;
});
