import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { normalizeSearchText } from "../services/medicationSearch";
import { sleep } from "../utils/sleep";

type SupportedTextEncoding = "utf-8" | "windows-1252";
type DatasetKey =
  | "specialties"
  | "presentations"
  | "compositions"
  | "genericGroups"
  | "prescriptionConditions"
  | "availability"
  | "therapeuticInterests"
  | "importantInfos";

interface CliOptions {
  chunkSize: number;
  downloadDir?: string;
  keepDownloads: boolean;
  timeoutMs: number;
  baseFileUrl: string;
  importantInfoUrl: string;
}

interface DownloadedDataset {
  key: DatasetKey;
  filename: string;
  url: string;
  filePath: string;
}

interface ImportContext {
  logger: NdjsonLogger;
  validCisSet: Set<string>;
}

interface DatasetDefinition<Row> {
  key: DatasetKey;
  filename: string;
  buildUrl: (opts: CliOptions) => string;
  expectedColumns: number;
  parse: (fields: string[], lineNumber: number, ctx: ImportContext) => Row;
  insert: (prisma: PrismaClient, rows: Row[]) => Promise<number>;
}

const DEFAULT_CHUNK_SIZE = 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_FILE_URL = "https://base-donnees-publique.medicaments.gouv.fr/download/file/";
const DEFAULT_IMPORTANT_INFO_URL = "https://base-donnees-publique.medicaments.gouv.fr/download/CIS_InfoImportantes.txt";
const DOWNLOAD_RETRIES = 3;

const DATASETS: readonly DatasetDefinition<unknown>[] = [
  {
    key: "specialties",
    filename: "CIS_bdpm.txt",
    buildUrl: (opts) => new URL("CIS_bdpm.txt", opts.baseFileUrl).toString(),
    expectedColumns: 12,
    parse: (fields, lineNumber, _ctx) => parseSpecialty(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmMedication.createMany({
      data: rows as Prisma.BdpmMedicationCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "presentations",
    filename: "CIS_CIP_bdpm.txt",
    buildUrl: (opts) => new URL("CIS_CIP_bdpm.txt", opts.baseFileUrl).toString(),
    expectedColumns: 13,
    parse: (fields, lineNumber, _ctx) => parsePresentation(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmPresentation.createMany({
      data: rows as Prisma.BdpmPresentationCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "compositions",
    filename: "CIS_COMPO_bdpm.txt",
    buildUrl: (opts) => new URL("CIS_COMPO_bdpm.txt", opts.baseFileUrl).toString(),
    expectedColumns: 8,
    parse: (fields, lineNumber, _ctx) => parseComposition(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmComposition.createMany({
      data: rows as Prisma.BdpmCompositionCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "genericGroups",
    filename: "CIS_GENER_bdpm.txt",
    buildUrl: (opts) => new URL("CIS_GENER_bdpm.txt", opts.baseFileUrl).toString(),
    expectedColumns: 5,
    parse: (fields, lineNumber, _ctx) => parseGenericGroupMember(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmGenericGroupMember.createMany({
      data: rows as Prisma.BdpmGenericGroupMemberCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "prescriptionConditions",
    filename: "CIS_CPD_bdpm.txt",
    buildUrl: (opts) => new URL("CIS_CPD_bdpm.txt", opts.baseFileUrl).toString(),
    expectedColumns: 2,
    parse: (fields, lineNumber, _ctx) => parsePrescriptionCondition(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmPrescriptionCondition.createMany({
      data: rows as Prisma.BdpmPrescriptionConditionCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "availability",
    filename: "CIS_CIP_Dispo_Spec.txt",
    buildUrl: (opts) => new URL("CIS_CIP_Dispo_Spec.txt", opts.baseFileUrl).toString(),
    expectedColumns: 8,
    parse: (fields, lineNumber, _ctx) => parseAvailabilityStatus(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmAvailabilityStatus.createMany({
      data: rows as Prisma.BdpmAvailabilityStatusCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "therapeuticInterests",
    filename: "CIS_MITM.txt",
    buildUrl: (opts) => new URL("CIS_MITM.txt", opts.baseFileUrl).toString(),
    expectedColumns: 4,
    parse: (fields, lineNumber, _ctx) => parseTherapeuticInterest(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmTherapeuticInterest.createMany({
      data: rows as Prisma.BdpmTherapeuticInterestCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
  {
    key: "importantInfos",
    filename: "CIS_InfoImportantes.txt",
    buildUrl: (opts) => opts.importantInfoUrl,
    expectedColumns: 4,
    parse: (fields, lineNumber, _ctx) => parseImportantInfo(fields, lineNumber),
    insert: (prisma, rows) => prisma.bdpmImportantInfo.createMany({
      data: rows as Prisma.BdpmImportantInfoCreateManyInput[],
      skipDuplicates: true,
    }).then((result) => result.count),
  },
];

async function main(): Promise<void> {
  const opts = parseCliOptions(process.argv.slice(2));
  const logger = new NdjsonLogger(
    "cron",
    process.env.ML_SITE_ID?.trim() || "bdpm-sync",
    process.env.SOSPRESCRIPTION_ENV?.trim() || "dev",
  );
  const prisma = new PrismaClient();
  const downloadDir = opts.downloadDir ?? await mkdtemp(path.join(os.tmpdir(), "bdpm-sync-"));
  const ctx: ImportContext = { logger, validCisSet: new Set() };

  logger.info(
    "bdpm.sync.started",
    {
      chunk_size: opts.chunkSize,
      download_dir: downloadDir,
      important_info_url: opts.importantInfoUrl,
      base_file_url: opts.baseFileUrl,
      timeout_ms: opts.timeoutMs,
    },
    undefined,
  );

  try {
    const downloaded = await downloadAllDatasets(downloadDir, opts, logger);

    await prisma.$connect();
    await truncateBdpmTables(prisma);

    for (const downloadedDataset of downloaded) {
      const definition = findDatasetDefinition(downloadedDataset.key);

      if (downloadedDataset.key !== "specialties" && ctx.validCisSet.size === 0) {
        logger.info("bdpm.sync.loading_valid_cis", {}, undefined);
        const meds = await prisma.bdpmMedication.findMany({ select: { cis: true } });
        for (const medication of meds) {
          ctx.validCisSet.add(medication.cis);
        }
        logger.info("bdpm.sync.valid_cis_loaded", { count: ctx.validCisSet.size }, undefined);
      }

      await importDatasetFile(definition, downloadedDataset, prisma, opts.chunkSize, ctx);
    }

    const counts = await collectRowCounts(prisma);
    logger.info("bdpm.sync.completed", counts, undefined);
  } catch (err: unknown) {
    logger.error(
      "bdpm.sync.failed",
      {
        reason: err instanceof Error ? err.message : "bdpm_sync_failed",
      },
      undefined,
      err,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);

    if (!opts.keepDownloads) {
      await rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function downloadAllDatasets(
  downloadDir: string,
  opts: CliOptions,
  logger: NdjsonLogger,
): Promise<DownloadedDataset[]> {
  const out: DownloadedDataset[] = [];

  for (const definition of DATASETS) {
    const url = definition.buildUrl(opts);
    const filePath = path.join(downloadDir, definition.filename);

    await downloadFileWithRetry(url, filePath, opts.timeoutMs, logger);

    const fileStat = await stat(filePath);
    logger.info(
      "bdpm.download.completed",
      {
        dataset: definition.key,
        filename: definition.filename,
        size_bytes: fileStat.size,
        url,
      },
      undefined,
    );

    out.push({
      key: definition.key,
      filename: definition.filename,
      url,
      filePath,
    });
  }

  return out;
}

async function downloadFileWithRetry(
  url: string,
  filePath: string,
  timeoutMs: number,
  logger: NdjsonLogger,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      await downloadFile(url, filePath, timeoutMs);
      return;
    } catch (err: unknown) {
      lastError = err;
      logger.warning(
        "bdpm.download.retry",
        {
          url,
          file_path: filePath,
          attempt,
          max_attempts: DOWNLOAD_RETRIES,
          reason: err instanceof Error ? err.message : "download_failed",
        },
        undefined,
        err,
      );

      if (attempt < DOWNLOAD_RETRIES) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to download ${url}`);
}

async function downloadFile(url: string, filePath: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "accept": "text/plain,application/octet-stream,*/*",
      "user-agent": "sosprescription-bdpm-sync/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status} for ${url}`);
  }

  if (!response.body) {
    throw new Error(`Download body missing for ${url}`);
  }

  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    createWriteStream(filePath),
  );
}

async function truncateBdpmTables(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction([
    prisma.bdpmAvailabilityStatus.deleteMany(),
    prisma.bdpmComposition.deleteMany(),
    prisma.bdpmGenericGroupMember.deleteMany(),
    prisma.bdpmImportantInfo.deleteMany(),
    prisma.bdpmPrescriptionCondition.deleteMany(),
    prisma.bdpmPresentation.deleteMany(),
    prisma.bdpmTherapeuticInterest.deleteMany(),
    prisma.bdpmMedication.deleteMany(),
  ]);
}

async function importDatasetFile<Row>(
  definition: DatasetDefinition<Row>,
  dataset: DownloadedDataset,
  prisma: PrismaClient,
  chunkSize: number,
  ctx: ImportContext,
): Promise<void> {
  const encoding = await detectFileEncoding(dataset.filePath);
  ctx.logger.info(
    "bdpm.import.started",
    {
      dataset: dataset.key,
      filename: dataset.filename,
      encoding,
      chunk_size: chunkSize,
    },
    undefined,
  );

  let lineNumber = 0;
  let insertedRows = 0;
  let chunk: Row[] = [];

  for await (const line of iterateFileLines(dataset.filePath, encoding)) {
    if (line.trim() === "") {
      continue;
    }

    lineNumber += 1;

    const fields = splitTabColumns(line, definition.expectedColumns);
    const parsed = definition.parse(fields, lineNumber, ctx);

    const cisValue = (parsed as { cis?: unknown }).cis;
    if (dataset.key !== "specialties" && typeof cisValue === "string" && !ctx.validCisSet.has(cisValue)) {
      continue;
    }

    chunk.push(parsed);

    if (chunk.length >= chunkSize) {
      insertedRows += await definition.insert(prisma, chunk);
      chunk = [];

      if (lineNumber % 10_000 === 0) {
        ctx.logger.info(
          "bdpm.import.progress",
          {
            dataset: dataset.key,
            line_number: lineNumber,
            inserted_rows: insertedRows,
          },
          undefined,
        );
      }
    }
  }

  if (chunk.length > 0) {
    insertedRows += await definition.insert(prisma, chunk);
  }

  ctx.logger.info(
    "bdpm.import.completed",
    {
      dataset: dataset.key,
      line_count: lineNumber,
      inserted_rows: insertedRows,
      encoding,
    },
    undefined,
  );
}

async function detectFileEncoding(filePath: string): Promise<SupportedTextEncoding> {
  const bytes = await readFile(filePath);

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

async function* iterateFileLines(
  filePath: string,
  encoding: SupportedTextEncoding,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder(encoding);
  const stream = createReadStream(filePath);
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      yield line;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.endsWith("\r")) {
    buffer = buffer.slice(0, -1);
  }

  if (buffer !== "") {
    yield buffer;
  }
}

function splitTabColumns(line: string, expectedColumns: number): string[] {
  const fields: string[] = [];
  let cursor = 0;

  for (let index = 0; index < expectedColumns - 1; index += 1) {
    const nextTab = line.indexOf("\t", cursor);
    if (nextTab < 0) {
      throw new Error(`Invalid BDPM row: expected ${expectedColumns} columns, got ${fields.length + 1}`);
    }

    fields.push(line.slice(cursor, nextTab));
    cursor = nextTab + 1;
  }

  fields.push(line.slice(cursor));
  return fields;
}

function parseSpecialty(fields: string[], lineNumber: number): Prisma.BdpmMedicationCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const denomination = requireString(fields[1], "denomination", lineNumber);

  return {
    cis,
    denomination,
    normalizedDenomination: normalizeSearchText(denomination),
    pharmaceuticalForm: requireString(fields[2], "pharmaceuticalForm", lineNumber),
    administrationRoutesRaw: requireString(fields[3], "administrationRoutesRaw", lineNumber),
    administrativeStatus: requireString(fields[4], "administrativeStatus", lineNumber),
    authorizationProcedure: requireString(fields[5], "authorizationProcedure", lineNumber),
    commercializationState: requireString(fields[6], "commercializationState", lineNumber),
    authorizationDate: parseOptionalFrenchDate(fields[7]),
    statusBdm: optionalString(fields[8]),
    europeanAuthorizationNumber: optionalString(fields[9]),
    holdersRaw: optionalString(fields[10]),
    isUnderAdditionalMonitoring: parseYesNoBoolean(fields[11]),
  };
}

function parsePresentation(fields: string[], lineNumber: number): Prisma.BdpmPresentationCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const cip7 = requireString(fields[1], "cip7", lineNumber);
  const label = requireString(fields[2], "label", lineNumber);
  const cip13 = requireString(fields[6], "cip13", lineNumber);

  return {
    id: stableRowId("presentation", [cis, cip13]),
    cis,
    cip7,
    cip13,
    label,
    normalizedLabel: normalizeSearchText(label),
    presentationStatus: requireString(fields[3], "presentationStatus", lineNumber),
    presentationCommercializationState: requireString(fields[4], "presentationCommercializationState", lineNumber),
    commercializationDeclarationDate: parseOptionalFrenchDate(fields[5]),
    collectivitiesApproval: optionalString(fields[7]),
    reimbursementRate: optionalString(fields[8]),
    priceEuro: parseOptionalDecimal(fields[9]),
    publicPriceEuro: parseOptionalDecimal(fields[10]),
    dispensingFeeEuro: parseOptionalDecimal(fields[11]),
    reimbursementIndications: optionalString(fields[12]),
  };
}

function parseComposition(fields: string[], lineNumber: number): Prisma.BdpmCompositionCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const designation = requireString(fields[1], "pharmaceuticalElementDesignation", lineNumber);
  const substanceCode = requireString(fields[2], "substanceCode", lineNumber);
  const substanceName = requireString(fields[3], "substanceName", lineNumber);
  const dosage = optionalString(fields[4]);
  const dosageReference = optionalString(fields[5]);
  const componentNature = requireString(fields[6], "componentNature", lineNumber);
  const componentLinkNumber = optionalString(fields[7]);

  return {
    id: stableRowId("composition", [cis, designation, substanceCode, substanceName, dosage ?? "", dosageReference ?? "", componentNature, componentLinkNumber ?? ""]),
    cis,
    pharmaceuticalElementDesignation: designation,
    substanceCode,
    substanceName,
    dosage,
    dosageReference,
    componentNature,
    componentLinkNumber,
  };
}

function parseGenericGroupMember(fields: string[], lineNumber: number): Prisma.BdpmGenericGroupMemberCreateManyInput {
  const groupId = requireString(fields[0], "groupId", lineNumber);
  const groupLabel = requireString(fields[1], "groupLabel", lineNumber);
  const cis = requireString(fields[2], "cis", lineNumber);
  const genericType = parseRequiredInteger(fields[3], "genericType", lineNumber);
  const sortOrder = parseRequiredInteger(fields[4], "sortOrder", lineNumber);

  return {
    id: stableRowId("genericGroupMember", [groupId, cis, String(genericType), String(sortOrder)]),
    cis,
    groupId,
    groupLabel,
    genericType,
    genericTypeLabel: mapGenericTypeLabel(genericType),
    sortOrder,
  };
}

function parsePrescriptionCondition(fields: string[], lineNumber: number): Prisma.BdpmPrescriptionConditionCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const conditionText = requireString(fields[1], "conditionText", lineNumber);

  return {
    id: stableRowId("prescriptionCondition", [cis, conditionText]),
    cis,
    conditionText,
    normalizedCondition: normalizeSearchText(conditionText),
  };
}

function parseAvailabilityStatus(fields: string[], lineNumber: number): Prisma.BdpmAvailabilityStatusCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const cip13 = optionalString(fields[1]);
  const statusCode = parseRequiredInteger(fields[2], "statusCode", lineNumber);
  const statusLabel = requireString(fields[3], "statusLabel", lineNumber);
  const startDate = parseOptionalFrenchDate(fields[4]);
  const updatedDate = parseOptionalFrenchDate(fields[5]);
  const resupplyDate = parseOptionalFrenchDate(fields[6]);
  const ansmUrl = requireString(fields[7], "ansmUrl", lineNumber);

  return {
    id: stableRowId("availabilityStatus", [cis, cip13 ?? "", String(statusCode), startDate?.toISOString() ?? "", updatedDate?.toISOString() ?? "", resupplyDate?.toISOString() ?? "", ansmUrl]),
    cis,
    cip13,
    statusCode,
    statusLabel,
    startDate,
    updatedDate,
    resupplyDate,
    ansmUrl,
  };
}

function parseTherapeuticInterest(fields: string[], lineNumber: number): Prisma.BdpmTherapeuticInterestCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const atcCode = requireString(fields[1], "atcCode", lineNumber);
  const denomination = requireString(fields[2], "denomination", lineNumber);
  const bdpmUrl = requireString(fields[3], "bdpmUrl", lineNumber);

  return {
    id: stableRowId("therapeuticInterest", [cis, atcCode]),
    cis,
    atcCode,
    denomination,
    bdpmUrl,
  };
}

function parseImportantInfo(fields: string[], lineNumber: number): Prisma.BdpmImportantInfoCreateManyInput {
  const cis = requireString(fields[0], "cis", lineNumber);
  const startDate = parseOptionalFrenchDate(fields[1]);
  const endDate = parseOptionalFrenchDate(fields[2]);
  const messageAndUrl = requireString(fields[3], "messageAndUrl", lineNumber);

  return {
    id: stableRowId("importantInfo", [cis, startDate?.toISOString() ?? "", endDate?.toISOString() ?? "", messageAndUrl]),
    cis,
    startDate,
    endDate,
    messageAndUrl,
  };
}

function requireString(value: string, field: string, lineNumber: number): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`Invalid ${field} at line ${lineNumber}`);
  }

  return normalized;
}

function optionalString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

function parseOptionalFrenchDate(value: string): Date | null {
  const normalized = optionalString(value);
  if (!normalized) {
    return null;
  }

  let day: number;
  let month: number;
  let year: number;

  const matchFr = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (matchFr) {
    day = Number(matchFr[1]);
    month = Number(matchFr[2]);
    year = Number(matchFr[3]);
  } else {
    const matchIso = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (matchIso) {
      year = Number(matchIso[1]);
      month = Number(matchIso[2]);
      day = Number(matchIso[3]);
    } else {
      throw new Error(`Invalid date format (expected DD/MM/YYYY or YYYY-MM-DD): ${normalized}`);
    }
  }

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date values: ${normalized}`);
  }

  return date;
}

function parseOptionalDecimal(value: string): string | null {
  const normalized = optionalString(value);
  if (!normalized) {
    return null;
  }

  // Nettoyage robuste pour les anomalies BDPM (ex: "1 466,29", "1,466,29", "1.466,29")
  let clean = normalized.replace(/\s+/g, '');

  const lastComma = clean.lastIndexOf(',');
  const lastDot = clean.lastIndexOf('.');
  const lastSeparatorIndex = Math.max(lastComma, lastDot);

  if (lastSeparatorIndex !== -1) {
    const integerPart = clean.substring(0, lastSeparatorIndex).replace(/[^0-9-]/g, '');
    const decimalPart = clean.substring(lastSeparatorIndex + 1).replace(/[^0-9]/g, '');
    clean = `${integerPart}.${decimalPart}`;
  } else {
    clean = clean.replace(/[^0-9-]/g, '');
  }

  if (!/^[-+]?\d+(?:\.\d+)?$/.test(clean) || clean === '') {
    return null;
  }

  return clean;
}

function parseRequiredInteger(value: string, field: string, lineNumber: number): number {
  const normalized = requireString(value, field, lineNumber);
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Invalid integer for ${field} at line ${lineNumber}`);
  }

  return Number(normalized);
}

function parseYesNoBoolean(value: string): boolean {
  const normalized = normalizeSearchText(value);
  if (normalized === "oui") {
    return true;
  }
  if (normalized === "non") {
    return false;
  }

  throw new Error(`Invalid yes/no boolean: ${value}`);
}

function mapGenericTypeLabel(genericType: number): string {
  switch (genericType) {
    case 0:
      return "princeps";
    case 1:
      return "générique";
    case 2:
      return "génériques par complémentarité posologique";
    case 4:
      return "générique substituable";
    default:
      return `type_${genericType}`;
  }
}

function stableRowId(kind: string, parts: readonly string[]): string {
  const hash = createHash("sha1");
  hash.update(kind);

  for (const part of parts) {
    hash.update("\u0000");
    hash.update(part);
  }

  return hash.digest("hex");
}

async function collectRowCounts(prisma: PrismaClient): Promise<Record<string, number>> {
  const [
    medications,
    presentations,
    compositions,
    genericGroupMembers,
    prescriptionConditions,
    availabilityStatuses,
    therapeuticInterests,
    importantInfos,
  ] = await Promise.all([
    prisma.bdpmMedication.count(),
    prisma.bdpmPresentation.count(),
    prisma.bdpmComposition.count(),
    prisma.bdpmGenericGroupMember.count(),
    prisma.bdpmPrescriptionCondition.count(),
    prisma.bdpmAvailabilityStatus.count(),
    prisma.bdpmTherapeuticInterest.count(),
    prisma.bdpmImportantInfo.count(),
  ]);

  return {
    medications,
    presentations,
    compositions,
    generic_group_members: genericGroupMembers,
    prescription_conditions: prescriptionConditions,
    availability_statuses: availabilityStatuses,
    therapeutic_interests: therapeuticInterests,
    important_infos: importantInfos,
  };
}

function parseCliOptions(argv: string[]): CliOptions {
  const optionMap = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    optionMap.set(rawKey, rawValue ?? "true");
  }

  return {
    chunkSize: normalizePositiveInt(optionMap.get("chunk-size") ?? process.env.BDPM_CHUNK_SIZE, DEFAULT_CHUNK_SIZE),
    downloadDir: normalizeOptionalPath(optionMap.get("download-dir") ?? process.env.BDPM_DOWNLOAD_DIR),
    keepDownloads: parseBooleanFlag(optionMap.get("keep-downloads") ?? process.env.BDPM_KEEP_DOWNLOADS, false),
    timeoutMs: normalizePositiveInt(optionMap.get("timeout-ms") ?? process.env.BDPM_HTTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    baseFileUrl: normalizeBaseUrl(optionMap.get("base-url") ?? process.env.BDPM_BASE_FILE_URL ?? DEFAULT_BASE_FILE_URL),
    importantInfoUrl: normalizeUrl(optionMap.get("important-info-url") ?? process.env.BDPM_IMPORTANT_INFO_URL ?? DEFAULT_IMPORTANT_INFO_URL),
  };
}

function normalizePositiveInt(value: string | undefined, fallback: number): number {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer option: ${normalized}`);
  }

  return parsed;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? undefined : path.resolve(normalized);
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(normalized);
}

function normalizeBaseUrl(value: string): string {
  const normalized = normalizeUrl(value);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeUrl(value: string): string {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    throw new Error("URL option is required");
  }

  return new URL(normalized).toString();
}

function findDatasetDefinition(key: DatasetKey): DatasetDefinition<unknown> {
  const dataset = DATASETS.find((candidate) => candidate.key === key);
  if (!dataset) {
    throw new Error(`Unknown dataset: ${key}`);
  }

  return dataset;
}

void main();
