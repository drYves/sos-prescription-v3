import {
  DocumentFetchStatus,
  DocumentIngestionRunStatus,
  DocumentPublicationStatus,
  DocumentType,
  OfficialDocumentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

export interface CreateRunInput {
  source: string;
  scope: string;
}

export interface FinishRunInput {
  status: DocumentIngestionRunStatus;
  statsJson?: Prisma.InputJsonValue;
  errorCode?: string;
  errorMessage?: string;
}

export interface RecordFetchAttemptInput {
  runId: string;
  cis: string;
  documentType: DocumentType;
  sourceUrl: string;
  status: DocumentFetchStatus;
  httpStatus?: number;
  fetchedAt?: Date;
  durationMs?: number;
  contentHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface StoreFetchedDocumentInput {
  fetchAttemptId: string;
  cis: string;
  documentType: DocumentType;
  sourceUrl: string;
  contentHash: string;
  rawHash: string;
  cleanHash: string;
  rawContent: string;
  cleanContent: string;
  officialUpdatedAt?: Date;
  fetchedAt: Date;
  metadataJson?: Prisma.InputJsonValue;
}

export interface StoreFetchedDocumentResult {
  versionId: string;
  versionCreated: boolean;
}

export class PrismaDocumentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async medicationExists(cis: string): Promise<boolean> {
    const row = await this.prisma.bdpmMedication.findUnique({ where: { cis }, select: { cis: true } });
    return row !== null;
  }

  async createIngestionRun(input: CreateRunInput): Promise<{ id: string }> {
    return this.prisma.documentIngestionRun.create({
      data: {
        source: input.source,
        scope: input.scope,
        status: DocumentIngestionRunStatus.RUNNING,
      },
      select: { id: true },
    });
  }

  async finishIngestionRun(runId: string, input: FinishRunInput): Promise<void> {
    await this.prisma.documentIngestionRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        finishedAt: new Date(),
        statsJson: input.statsJson ?? Prisma.JsonNull,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      },
    });
  }

  async documentVersionExists(cis: string, documentType: DocumentType, contentHash: string): Promise<boolean> {
    const existing = await this.prisma.officialDocumentVersion.findUnique({
      where: { cis_documentType_contentHash: { cis, documentType, contentHash } },
      select: { id: true },
    });
    return existing !== null;
  }

  async recordFetchAttempt(input: RecordFetchAttemptInput): Promise<{ id: string }> {
    return this.prisma.documentFetchAttempt.create({
      data: {
        runId: input.runId,
        cis: input.cis,
        documentType: input.documentType,
        sourceUrl: input.sourceUrl,
        status: input.status,
        httpStatus: input.httpStatus ?? null,
        fetchedAt: input.fetchedAt ?? null,
        durationMs: input.durationMs ?? null,
        contentHash: input.contentHash ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      },
      select: { id: true },
    });
  }

  async storeFetchedDocument(input: StoreFetchedDocumentInput): Promise<StoreFetchedDocumentResult> {
    const existing = await this.prisma.officialDocumentVersion.findUnique({
      where: {
        cis_documentType_contentHash: {
          cis: input.cis,
          documentType: input.documentType,
          contentHash: input.contentHash,
        },
      },
      select: { id: true },
    });

    const version = existing ?? await this.prisma.officialDocumentVersion.create({
      data: {
        cis: input.cis,
        documentType: input.documentType,
        fetchAttemptId: input.fetchAttemptId,
        sourceUrl: input.sourceUrl,
        contentHash: input.contentHash,
        rawHash: input.rawHash,
        cleanHash: input.cleanHash,
        rawContent: input.rawContent,
        cleanContent: input.cleanContent,
        officialUpdatedAt: input.officialUpdatedAt ?? null,
        fetchedAt: input.fetchedAt,
        metadataJson: input.metadataJson ?? Prisma.JsonNull,
      },
      select: { id: true },
    });

    await this.upsertCurrentDocument({
      cis: input.cis,
      documentType: input.documentType,
      currentVersionId: version.id,
      sourceUrl: input.sourceUrl,
      contentHash: input.contentHash,
      officialUpdatedAt: input.officialUpdatedAt,
      status: OfficialDocumentStatus.AVAILABLE,
    });

    await this.upsertPublicationAssessment({
      cis: input.cis,
      documentType: input.documentType,
      status: DocumentPublicationStatus.INTERNAL_ONLY,
      reasonCode: "LOT2_PILOT_INTERNAL_ONLY",
      reasonMessage: "Lot 2 pilot ingestion only; no product publication.",
      metadataJson: {
        source: "bdpm_extrait",
        versionId: version.id,
        versionCreated: existing === null,
      },
    });

    return { versionId: version.id, versionCreated: existing === null };
  }

  async upsertCurrentDocument(input: {
    cis: string;
    documentType: DocumentType;
    currentVersionId?: string;
    sourceUrl: string;
    contentHash?: string;
    officialUpdatedAt?: Date;
    status: OfficialDocumentStatus;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.officialDocumentCurrent.upsert({
      where: {
        cis_documentType: {
          cis: input.cis,
          documentType: input.documentType,
        },
      },
      create: {
        cis: input.cis,
        documentType: input.documentType,
        currentVersionId: input.currentVersionId ?? null,
        sourceUrl: input.sourceUrl,
        contentHash: input.contentHash ?? null,
        officialUpdatedAt: input.officialUpdatedAt ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        status: input.status,
      },
      update: {
        currentVersionId: input.currentVersionId ?? undefined,
        sourceUrl: input.sourceUrl,
        contentHash: input.contentHash ?? undefined,
        officialUpdatedAt: input.officialUpdatedAt ?? undefined,
        lastSeenAt: now,
        status: input.status,
      },
    });
  }

  async markCurrentMissingIfAbsent(cis: string, documentType: DocumentType, sourceUrl: string): Promise<void> {
    const existing = await this.prisma.officialDocumentCurrent.findUnique({
      where: { cis_documentType: { cis, documentType } },
      select: { id: true },
    });

    if (existing) {
      return;
    }

    await this.upsertCurrentDocument({
      cis,
      documentType,
      sourceUrl,
      status: OfficialDocumentStatus.MISSING,
    });
  }

  async upsertPublicationAssessment(input: {
    cis: string;
    documentType: DocumentType;
    status: DocumentPublicationStatus;
    reasonCode?: string;
    reasonMessage?: string;
    metadataJson?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.documentPublicationAssessment.upsert({
      where: {
        cis_documentType: {
          cis: input.cis,
          documentType: input.documentType,
        },
      },
      create: {
        cis: input.cis,
        documentType: input.documentType,
        status: input.status,
        reasonCode: input.reasonCode ?? null,
        reasonMessage: input.reasonMessage ?? null,
        metadataJson: input.metadataJson ?? Prisma.JsonNull,
      },
      update: {
        status: input.status,
        reasonCode: input.reasonCode ?? null,
        reasonMessage: input.reasonMessage ?? null,
        assessedAt: new Date(),
        metadataJson: input.metadataJson ?? Prisma.JsonNull,
      },
    });
  }
}
