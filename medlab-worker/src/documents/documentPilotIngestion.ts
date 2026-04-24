import {
  DocumentFetchStatus,
  DocumentIngestionRunStatus,
  DocumentPublicationStatus,
  DocumentType,
  OfficialDocumentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { NdjsonLogger } from "../logger";
import { BDPM_DOCUMENT_SOURCE, resolveBdpmExtraitSource } from "./bdpmOfficialDocumentSource";
import { fetchBdpmOfficialHtml } from "./bdpmOfficialDocumentFetcher";
import { sha256Hex } from "./documentHashing";
import { extractAndNormalizeRcp } from "./documentNormalizer";
import { PrismaDocumentStore } from "./prismaDocumentStore";

export interface DocumentPilotIngestionOptions {
  cis: string;
  documentType: DocumentType;
  fetchTimeoutMs?: number;
}

export interface DocumentPilotIngestionResult {
  ok: boolean;
  runId: string;
  cis: string;
  documentType: DocumentType;
  sourceUrl?: string;
  fetchStatus?: DocumentFetchStatus;
  versionId?: string;
  versionCreated: boolean;
  contentHash?: string;
  currentUpdated: boolean;
  assessmentStatus?: DocumentPublicationStatus;
  errorCode?: string;
  errorMessage?: string;
  stats: DocumentPilotRunStats;
}

export interface DocumentPilotRunStats {
  cisProcessed: number;
  fetchSuccess: number;
  fetchNotFound: number;
  fetchErrors: number;
  versionsCreated: number;
  versionsUnchanged: number;
  assessmentsUpserted: number;
}

const EMPTY_STATS: DocumentPilotRunStats = {
  cisProcessed: 0,
  fetchSuccess: 0,
  fetchNotFound: 0,
  fetchErrors: 0,
  versionsCreated: 0,
  versionsUnchanged: 0,
  assessmentsUpserted: 0,
};

export class DocumentPilotIngestion {
  private readonly store: PrismaDocumentStore;

  constructor(
    prisma: PrismaClient,
    private readonly logger: NdjsonLogger,
  ) {
    this.store = new PrismaDocumentStore(prisma);
  }

  async run(options: DocumentPilotIngestionOptions): Promise<DocumentPilotIngestionResult> {
    const scope = `pilot:cis=${options.cis}:type=${options.documentType}`;
    const run = await this.store.createIngestionRun({ source: BDPM_DOCUMENT_SOURCE, scope });
    const stats: DocumentPilotRunStats = { ...EMPTY_STATS };

    this.logger.info("run.started", { runId: run.id, cis: options.cis, documentType: options.documentType, source: BDPM_DOCUMENT_SOURCE });

    try {
      if (options.documentType !== DocumentType.RCP) {
        return await this.failRun(run.id, options, stats, "DOCUMENT_TYPE_UNSUPPORTED", "Lot 2 pilot supports RCP only.");
      }

      const source = resolveBdpmExtraitSource(options.cis);
      const exists = await this.store.medicationExists(source.cis);
      if (!exists) {
        return await this.failRun(run.id, { ...options, cis: source.cis }, stats, "CIS_NOT_FOUND", `CIS ${source.cis} not found in BdpmMedication.`);
      }

      stats.cisProcessed = 1;
      this.logger.info("document.fetch.started", { runId: run.id, cis: source.cis, documentType: options.documentType, sourceUrl: source.sourceUrl });

      const fetched = await fetchBdpmOfficialHtml(source.sourceUrl, options.fetchTimeoutMs);
      if (fetched.errorCode) {
        return await this.handleFetchError(run.id, source.cis, options.documentType, source.sourceUrl, fetched, stats);
      }

      if (!fetched.rawHtml) {
        return await this.handleFetchError(run.id, source.cis, options.documentType, source.sourceUrl, { ...fetched, errorCode: "EMPTY_CONTENT" }, stats);
      }

      let normalized;
      try {
        normalized = extractAndNormalizeRcp(fetched.rawHtml);
      } catch (err) {
        return await this.handleParseError(run.id, source.cis, options.documentType, source.sourceUrl, fetched, stats, err);
      }
      const rawHash = sha256Hex(normalized.rawContent);
      const cleanHash = sha256Hex(normalized.cleanContent);
      const contentHash = cleanHash;
      const fetchedAt = new Date();

      const existingVersion = await this.store.documentVersionExists(source.cis, options.documentType, contentHash);
      const fetchStatus = existingVersion ? DocumentFetchStatus.NOT_MODIFIED : DocumentFetchStatus.SUCCESS;

      const fetchAttempt = await this.store.recordFetchAttempt({
        runId: run.id,
        cis: source.cis,
        documentType: options.documentType,
        sourceUrl: source.sourceUrl,
        status: fetchStatus,
        httpStatus: fetched.httpStatus,
        fetchedAt,
        durationMs: fetched.durationMs,
        contentHash,
      });

      this.logger.info("document.fetch.completed", {
        runId: run.id,
        cis: source.cis,
        documentType: options.documentType,
        sourceUrl: source.sourceUrl,
        fetchStatus,
        httpStatus: fetched.httpStatus,
        durationMs: fetched.durationMs,
        contentHash,
      });

      const stored = await this.store.storeFetchedDocument({
        fetchAttemptId: fetchAttempt.id,
        cis: source.cis,
        documentType: options.documentType,
        sourceUrl: source.sourceUrl,
        contentHash,
        rawHash,
        cleanHash,
        rawContent: normalized.rawContent,
        cleanContent: normalized.cleanContent,
        officialUpdatedAt: normalized.officialUpdatedAt,
        fetchedAt,
        metadataJson: {
          source: BDPM_DOCUMENT_SOURCE,
          finalUrl: fetched.finalUrl,
          extractionStrategy: normalized.extractionStrategy,
          pilot: true,
        },
      });

      stats.fetchSuccess = 1;
      if (stored.versionCreated) {
        stats.versionsCreated = 1;
        this.logger.info("document.version.created", { runId: run.id, cis: source.cis, documentType: options.documentType, versionId: stored.versionId, contentHash });
      } else {
        stats.versionsUnchanged = 1;
        this.logger.info("document.version.not_modified", { runId: run.id, cis: source.cis, documentType: options.documentType, versionId: stored.versionId, contentHash });
      }

      stats.assessmentsUpserted = 1;
      this.logger.info("document.current.updated", { runId: run.id, cis: source.cis, documentType: options.documentType, versionId: stored.versionId, contentHash });
      this.logger.info("document.assessment.upserted", { runId: run.id, cis: source.cis, documentType: options.documentType, status: DocumentPublicationStatus.INTERNAL_ONLY });

      await this.store.finishIngestionRun(run.id, {
        status: DocumentIngestionRunStatus.COMPLETED,
        statsJson: stats as unknown as Prisma.InputJsonValue,
      });
      this.logger.info("run.completed", { runId: run.id, cis: source.cis, documentType: options.documentType, stats });

      return {
        ok: true,
        runId: run.id,
        cis: source.cis,
        documentType: options.documentType,
        sourceUrl: source.sourceUrl,
        fetchStatus,
        versionId: stored.versionId,
        versionCreated: stored.versionCreated,
        contentHash,
        currentUpdated: true,
        assessmentStatus: DocumentPublicationStatus.INTERNAL_ONLY,
        stats,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = errorMessage.startsWith("INVALID_CIS") ? "INVALID_CIS" : "RUN_FAILED";
      stats.fetchErrors += 1;
      await this.store.finishIngestionRun(run.id, {
        status: DocumentIngestionRunStatus.FAILED,
        statsJson: stats as unknown as Prisma.InputJsonValue,
        errorCode,
        errorMessage,
      });
      this.logger.error("run.failed", { runId: run.id, cis: options.cis, documentType: options.documentType, stats, errorCode }, undefined, err);
      return {
        ok: false,
        runId: run.id,
        cis: options.cis,
        documentType: options.documentType,
        versionCreated: false,
        currentUpdated: false,
        errorCode,
        errorMessage,
        stats,
      };
    }
  }

  private async handleFetchError(
    runId: string,
    cis: string,
    documentType: DocumentType,
    sourceUrl: string,
    fetched: { httpStatus: number; durationMs: number; errorCode?: string; errorMessage?: string },
    stats: DocumentPilotRunStats,
  ): Promise<DocumentPilotIngestionResult> {
    const errorCode = fetched.errorCode ?? "FETCH_FAILED";
    const status = mapFetchErrorToStatus(errorCode);

    await this.store.recordFetchAttempt({
      runId,
      cis,
      documentType,
      sourceUrl,
      status,
      httpStatus: fetched.httpStatus,
      fetchedAt: new Date(),
      durationMs: fetched.durationMs,
      errorCode,
      errorMessage: fetched.errorMessage,
    });

    if (status === DocumentFetchStatus.NOT_FOUND) {
      stats.fetchNotFound = 1;
      await this.store.markCurrentMissingIfAbsent(cis, documentType, sourceUrl);
    } else {
      stats.fetchErrors = 1;
      if (errorCode === "OFFSITE_SOURCE_UNSUPPORTED") {
        await this.store.upsertCurrentDocument({ cis, documentType, sourceUrl, status: OfficialDocumentStatus.BLOCKED });
      }
    }

    const assessmentStatus = errorCode === "OFFSITE_SOURCE_UNSUPPORTED" || status === DocumentFetchStatus.NOT_FOUND
      ? DocumentPublicationStatus.BLOCKED
      : DocumentPublicationStatus.NEEDS_REVIEW;

    await this.store.upsertPublicationAssessment({
      cis,
      documentType,
      status: assessmentStatus,
      reasonCode: errorCode,
      reasonMessage: fetched.errorMessage ?? errorCode,
      metadataJson: { source: BDPM_DOCUMENT_SOURCE, pilot: true, httpStatus: fetched.httpStatus },
    });
    stats.assessmentsUpserted = 1;

    await this.store.finishIngestionRun(runId, {
      status: DocumentIngestionRunStatus.COMPLETED_WITH_ERRORS,
      statsJson: stats as unknown as Prisma.InputJsonValue,
      errorCode,
      errorMessage: fetched.errorMessage ?? errorCode,
    });

    this.logger.warning("document.fetch.completed", { runId, cis, documentType, sourceUrl, fetchStatus: status, httpStatus: fetched.httpStatus, errorCode });
    this.logger.warning("document.assessment.upserted", { runId, cis, documentType, status: assessmentStatus, reasonCode: errorCode });
    this.logger.warning("run.failed", { runId, cis, documentType, stats, errorCode });

    return {
      ok: false,
      runId,
      cis,
      documentType,
      sourceUrl,
      fetchStatus: status,
      versionCreated: false,
      currentUpdated: errorCode === "OFFSITE_SOURCE_UNSUPPORTED" || status === DocumentFetchStatus.NOT_FOUND,
      assessmentStatus,
      errorCode,
      errorMessage: fetched.errorMessage ?? errorCode,
      stats,
    };
  }

  private async handleParseError(
    runId: string,
    cis: string,
    documentType: DocumentType,
    sourceUrl: string,
    fetched: { httpStatus: number; durationMs: number },
    stats: DocumentPilotRunStats,
    err: unknown,
  ): Promise<DocumentPilotIngestionResult> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = errorMessage || "PARSE_ERROR";
    stats.fetchErrors = 1;

    await this.store.recordFetchAttempt({
      runId,
      cis,
      documentType,
      sourceUrl,
      status: DocumentFetchStatus.PARSE_ERROR,
      httpStatus: fetched.httpStatus,
      fetchedAt: new Date(),
      durationMs: fetched.durationMs,
      errorCode,
      errorMessage,
    });

    await this.store.upsertPublicationAssessment({
      cis,
      documentType,
      status: DocumentPublicationStatus.NEEDS_REVIEW,
      reasonCode: errorCode,
      reasonMessage: errorMessage,
      metadataJson: { source: BDPM_DOCUMENT_SOURCE, pilot: true, httpStatus: fetched.httpStatus },
    });
    stats.assessmentsUpserted = 1;

    await this.store.finishIngestionRun(runId, {
      status: DocumentIngestionRunStatus.COMPLETED_WITH_ERRORS,
      statsJson: stats as unknown as Prisma.InputJsonValue,
      errorCode,
      errorMessage,
    });

    this.logger.warning("document.fetch.completed", { runId, cis, documentType, sourceUrl, fetchStatus: DocumentFetchStatus.PARSE_ERROR, httpStatus: fetched.httpStatus, errorCode });
    this.logger.warning("document.assessment.upserted", { runId, cis, documentType, status: DocumentPublicationStatus.NEEDS_REVIEW, reasonCode: errorCode });
    this.logger.warning("run.failed", { runId, cis, documentType, stats, errorCode });

    return {
      ok: false,
      runId,
      cis,
      documentType,
      sourceUrl,
      fetchStatus: DocumentFetchStatus.PARSE_ERROR,
      versionCreated: false,
      currentUpdated: false,
      assessmentStatus: DocumentPublicationStatus.NEEDS_REVIEW,
      errorCode,
      errorMessage,
      stats,
    };
  }

  private async failRun(
    runId: string,
    options: DocumentPilotIngestionOptions,
    stats: DocumentPilotRunStats,
    errorCode: string,
    errorMessage: string,
  ): Promise<DocumentPilotIngestionResult> {
    await this.store.finishIngestionRun(runId, {
      status: DocumentIngestionRunStatus.FAILED,
      statsJson: stats as unknown as Prisma.InputJsonValue,
      errorCode,
      errorMessage,
    });
    this.logger.error("run.failed", { runId, cis: options.cis, documentType: options.documentType, stats, errorCode, errorMessage });
    return {
      ok: false,
      runId,
      cis: options.cis,
      documentType: options.documentType,
      versionCreated: false,
      currentUpdated: false,
      errorCode,
      errorMessage,
      stats,
    };
  }
}

function mapFetchErrorToStatus(errorCode: string): DocumentFetchStatus {
  if (errorCode === "DOCUMENT_NOT_FOUND") return DocumentFetchStatus.NOT_FOUND;
  if (errorCode === "HTTP_ERROR") return DocumentFetchStatus.HTTP_ERROR;
  if (errorCode === "OFFSITE_SOURCE_UNSUPPORTED") return DocumentFetchStatus.FAILED;
  return DocumentFetchStatus.FAILED;
}
