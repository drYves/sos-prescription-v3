import {
  DocumentPublicationStatus,
  DocumentType,
  OfficialDocumentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { normalizeCis } from "./bdpmOfficialDocumentSource";

const DEFAULT_PREVIEW_CHARS = 800;
const MAX_PREVIEW_CHARS = 5000;

export type DocumentReadErrorCode =
  | "CIS_NOT_FOUND"
  | "DOCUMENT_TYPE_UNSUPPORTED"
  | "DOCUMENT_NOT_INGESTED"
  | "CURRENT_VERSION_MISSING"
  | "VERSION_NOT_FOUND"
  | "DOCUMENT_BLOCKED"
  | "DOCUMENT_NEEDS_REVIEW"
  | "READ_FAILED";

export interface DocumentReadOptions {
  cis: string;
  documentType: DocumentType;
  includeContent?: boolean;
  previewChars?: number;
}

export interface DocumentReadPayload {
  ok: boolean;
  cis: string;
  documentType: DocumentType;
  errorCode?: DocumentReadErrorCode;
  errorMessage?: string;
  current?: DocumentReadCurrentPayload;
  version?: DocumentReadVersionPayload;
  assessment?: DocumentReadAssessmentPayload;
}

export interface DocumentReadCurrentPayload {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  contentHash: string | null;
  sourceUrl: string;
  officialUpdatedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DocumentReadVersionPayload {
  id: string;
  contentHash: string;
  rawHash: string | null;
  cleanHash: string | null;
  sourceUrl: string;
  fetchedAt: string;
  createdAt: string;
  metadataJson: Prisma.JsonValue | Record<string, never>;
  cleanContentPreview: string;
  cleanContentLength: number;
  cleanContent?: string;
}

export interface DocumentReadAssessmentPayload {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: string;
}

interface CurrentRecord {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  contentHash: string | null;
  sourceUrl: string;
  officialUpdatedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface VersionRecord {
  id: string;
  contentHash: string;
  rawHash: string | null;
  cleanHash: string | null;
  sourceUrl: string;
  fetchedAt: Date;
  createdAt: Date;
  metadataJson: Prisma.JsonValue | null;
  cleanContent: string | null;
}

interface AssessmentRecord {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: Date;
}

export class DocumentReader {
  constructor(private readonly prisma: PrismaClient) {}

  async read(options: DocumentReadOptions): Promise<DocumentReadPayload> {
    let cis: string;
    try {
      cis = normalizeCis(options.cis);
    } catch (err) {
      return fail("READ_FAILED", options.cis, options.documentType, err instanceof Error ? err.message : String(err));
    }

    try {
      if (options.documentType !== DocumentType.RCP) {
        return fail("DOCUMENT_TYPE_UNSUPPORTED", cis, options.documentType, "Lot 2C supports RCP only.");
      }

      const medication = await this.prisma.bdpmMedication.findUnique({
        where: { cis },
        select: { cis: true },
      });
      if (!medication) {
        return fail("CIS_NOT_FOUND", cis, options.documentType, `CIS ${cis} not found in BdpmMedication.`);
      }

      const [current, assessment] = await Promise.all([
        this.prisma.officialDocumentCurrent.findUnique({
          where: {
            cis_documentType: {
              cis,
              documentType: options.documentType,
            },
          },
          select: {
            status: true,
            currentVersionId: true,
            contentHash: true,
            sourceUrl: true,
            officialUpdatedAt: true,
            firstSeenAt: true,
            lastSeenAt: true,
          },
        }),
        this.prisma.documentPublicationAssessment.findUnique({
          where: {
            cis_documentType: {
              cis,
              documentType: options.documentType,
            },
          },
          select: {
            status: true,
            reasonCode: true,
            assessedAt: true,
          },
        }),
      ]);

      const currentPayload = mapCurrent(current);
      const assessmentPayload = mapAssessment(assessment);

      if (current?.status === OfficialDocumentStatus.BLOCKED || assessment?.status === DocumentPublicationStatus.BLOCKED) {
        return fail("DOCUMENT_BLOCKED", cis, options.documentType, "Document blocked for internal reading.", currentPayload, undefined, assessmentPayload);
      }

      if (assessment?.status === DocumentPublicationStatus.NEEDS_REVIEW && (!current || current.status !== OfficialDocumentStatus.AVAILABLE)) {
        return fail("DOCUMENT_NEEDS_REVIEW", cis, options.documentType, "Document requires review before internal read.", currentPayload, undefined, assessmentPayload);
      }

      if (!current) {
        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, "No current documentary state found for this CIS.", undefined, undefined, assessmentPayload);
      }

      if (current.status !== OfficialDocumentStatus.AVAILABLE) {
        if (assessment?.status === DocumentPublicationStatus.NEEDS_REVIEW) {
          return fail("DOCUMENT_NEEDS_REVIEW", cis, options.documentType, "Document current state is not available and requires review.", currentPayload, undefined, assessmentPayload);
        }

        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, `Document current status is ${current.status}.`, currentPayload, undefined, assessmentPayload);
      }

      if (!current.currentVersionId) {
        return fail("CURRENT_VERSION_MISSING", cis, options.documentType, "Current documentary state has no currentVersionId.", currentPayload, undefined, assessmentPayload);
      }

      const version = await this.prisma.officialDocumentVersion.findUnique({
        where: { id: current.currentVersionId },
        select: {
          id: true,
          contentHash: true,
          rawHash: true,
          cleanHash: true,
          sourceUrl: true,
          fetchedAt: true,
          createdAt: true,
          metadataJson: true,
          cleanContent: true,
        },
      });

      if (!version) {
        return fail("VERSION_NOT_FOUND", cis, options.documentType, `Current version ${current.currentVersionId} not found.`, currentPayload, undefined, assessmentPayload);
      }

      const versionPayload = mapVersion(version, {
        includeContent: options.includeContent ?? false,
        previewChars: normalizePreviewChars(options.previewChars),
      });

      return {
        ok: true,
        cis,
        documentType: options.documentType,
        current: currentPayload,
        version: versionPayload,
        assessment: assessmentPayload,
      };
    } catch (err) {
      return fail("READ_FAILED", cis, options.documentType, err instanceof Error ? err.message : String(err));
    }
  }
}

function normalizePreviewChars(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_PREVIEW_CHARS;
  }

  const normalized = Math.trunc(value);
  if (normalized <= 0) {
    return DEFAULT_PREVIEW_CHARS;
  }

  return Math.min(normalized, MAX_PREVIEW_CHARS);
}

function mapCurrent(current: CurrentRecord | null): DocumentReadCurrentPayload | undefined {
  if (!current) return undefined;
  return {
    status: current.status,
    currentVersionId: current.currentVersionId,
    contentHash: current.contentHash,
    sourceUrl: current.sourceUrl,
    officialUpdatedAt: toIso(current.officialUpdatedAt),
    firstSeenAt: current.firstSeenAt.toISOString(),
    lastSeenAt: current.lastSeenAt.toISOString(),
  };
}

function mapAssessment(assessment: AssessmentRecord | null): DocumentReadAssessmentPayload | undefined {
  if (!assessment) return undefined;
  return {
    status: assessment.status,
    reasonCode: assessment.reasonCode,
    assessedAt: assessment.assessedAt.toISOString(),
  };
}

function mapVersion(
  version: VersionRecord,
  options: { includeContent: boolean; previewChars: number },
): DocumentReadVersionPayload {
  const cleanContent = typeof version.cleanContent === "string" ? version.cleanContent : "";
  const payload: DocumentReadVersionPayload = {
    id: version.id,
    contentHash: version.contentHash,
    rawHash: version.rawHash,
    cleanHash: version.cleanHash,
    sourceUrl: version.sourceUrl,
    fetchedAt: version.fetchedAt.toISOString(),
    createdAt: version.createdAt.toISOString(),
    metadataJson: version.metadataJson ?? {},
    cleanContentPreview: cleanContent.slice(0, options.previewChars),
    cleanContentLength: cleanContent.length,
  };

  if (options.includeContent) {
    payload.cleanContent = cleanContent;
  }

  return payload;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function fail(
  errorCode: DocumentReadErrorCode,
  cis: string,
  documentType: DocumentType,
  errorMessage: string,
  current?: DocumentReadCurrentPayload,
  version?: DocumentReadVersionPayload,
  assessment?: DocumentReadAssessmentPayload,
): DocumentReadPayload {
  return {
    ok: false,
    cis,
    documentType,
    errorCode,
    errorMessage,
    current,
    version,
    assessment,
  };
}
