import { DocumentType, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { DocumentSectionExtractor } from "./documentSectionExtractor";

interface CliOptions {
  cis: string;
  documentType: DocumentType;
  versionId?: string;
  dryRun: boolean;
  includeContent: boolean;
  parserVersion?: string;
}

const DEFAULT_CIS = "67017786";

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-section",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  const prisma = new PrismaClient();

  logger.info("document.section.started", {
    cis: opts.cis,
    documentType: opts.documentType,
    dryRun: opts.dryRun,
    includeContent: opts.includeContent,
    parserVersion: opts.parserVersion,
    versionId: opts.versionId,
  });

  try {
    const extractor = new DocumentSectionExtractor(prisma);
    const result = await extractor.extract({
      cis: opts.cis,
      documentType: opts.documentType,
      versionId: opts.versionId,
      dryRun: opts.dryRun,
      includeContent: opts.includeContent,
      parserVersion: opts.parserVersion,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    if (result.ok) {
      logger.info("document.section.parsed", {
        cis: result.cis,
        documentType: result.documentType,
        versionId: result.versionId,
        dryRun: result.dryRun,
        parserVersion: result.parserVersion,
        sectionCount: result.sectionCount,
        missingExpectedSections: result.missingExpectedSections,
      });
      if (!result.dryRun) {
        logger.info("document.section.persisted", {
          cis: result.cis,
          documentType: result.documentType,
          versionId: result.versionId,
          sectionCount: result.sectionCount,
        });
      }
    } else {
      logger.warning("document.section.failed", {
        cis: result.cis,
        documentType: result.documentType,
        versionId: result.versionId,
        dryRun: result.dryRun,
        errorCode: result.errorCode,
        currentStatus: result.current?.status,
        assessmentStatus: result.assessment?.status,
        missingExpectedSections: result.missingExpectedSections,
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
    versionId: values.versionId?.trim() || undefined,
    dryRun: parseBoolean(values.dryRun),
    includeContent: parseBoolean(values.includeContent),
    parserVersion: values.parserVersion?.trim() || undefined,
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

main().catch((err) => {
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "document-section",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  logger.error("document.section.failed", { errorCode: "PROCESS_FATAL" }, undefined, err);
  process.exitCode = 1;
});
