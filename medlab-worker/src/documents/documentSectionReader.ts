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

export type DocumentSectionReadErrorCode =
  | "CIS_NOT_FOUND"
  | "DOCUMENT_TYPE_UNSUPPORTED"
  | "DOCUMENT_NOT_INGESTED"
  | "CURRENT_VERSION_MISSING"
  | "VERSION_NOT_FOUND"
  | "DOCUMENT_BLOCKED"
  | "DOCUMENT_NEEDS_REVIEW"
  | "SECTIONS_NOT_FOUND"
  | "READ_FAILED";

export interface DocumentSectionReadOptions {
  cis: string;
  documentType: DocumentType;
  versionId?: string;
  includeContent?: boolean;
  previewChars?: number;
}

export interface DocumentSectionReadPayload {
  ok: boolean;
  cis: string;
  documentType: DocumentType;
  errorCode?: DocumentSectionReadErrorCode;
  errorMessage?: string;
  current?: DocumentSectionReadCurrentPayload;
  version?: DocumentSectionReadVersionPayload;
  assessment?: DocumentSectionReadAssessmentPayload;
  sections?: DocumentSectionReadSectionPayload[];
  sectionCount?: number;
  missingExpectedSections?: string[];
}

export interface DocumentSectionReadCurrentPayload {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  contentHash: string | null;
  sourceUrl: string;
  lastSeenAt: string;
}

export interface DocumentSectionReadVersionPayload {
  id: string;
  contentHash: string;
  cleanHash: string | null;
  fetchedAt: string;
  createdAt: string;
}

export interface DocumentSectionReadAssessmentPayload {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: string;
}

export interface DocumentSectionReadSectionPayload {
  sectionKey: string;
  title: string | null;
  position: number;
  contentHash: string;
  contentPreview: string;
  contentLength: number;
  metadataJson: Prisma.JsonValue | Record<string, never>;
  content?: string;
}

interface CurrentRecord {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  contentHash: string | null;
  sourceUrl: string;
  lastSeenAt: Date;
}

interface VersionRecord {
  id: string;
  contentHash: string;
  cleanHash: string | null;
  fetchedAt: Date;
  createdAt: Date;
}

interface AssessmentRecord {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: Date;
}

interface SectionRecord {
  sectionKey: string;
  title: string | null;
  position: number;
  contentHash: string;
  content: string | null;
  metadataJson: Prisma.JsonValue | null;
}

export class DocumentSectionReader {
  constructor(private readonly prisma: PrismaClient) {}

  async read(options: DocumentSectionReadOptions): Promise<DocumentSectionReadPayload> {
    let cis: string;
    try {
      cis = normalizeCis(options.cis);
    } catch (err) {
      return fail("READ_FAILED", options.cis, options.documentType, err instanceof Error ? err.message : String(err));
    }

    try {
      if (options.documentType !== DocumentType.RCP) {
        return fail("DOCUMENT_TYPE_UNSUPPORTED", cis, options.documentType, "Lot 3B supports RCP only.");
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
          where: { cis_documentType: { cis, documentType: options.documentType } },
          select: {
            status: true,
            currentVersionId: true,
            contentHash: true,
            sourceUrl: true,
            lastSeenAt: true,
          },
        }),
        this.prisma.documentPublicationAssessment.findUnique({
          where: { cis_documentType: { cis, documentType: options.documentType } },
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
        return fail("DOCUMENT_BLOCKED", cis, options.documentType, "Document blocked for section read.", currentPayload, undefined, assessmentPayload);
      }

      if (assessment?.status === DocumentPublicationStatus.NEEDS_REVIEW && (!current || current.status !== OfficialDocumentStatus.AVAILABLE)) {
        return fail("DOCUMENT_NEEDS_REVIEW", cis, options.documentType, "Document requires review before section read.", currentPayload, undefined, assessmentPayload);
      }

      if (!current) {
        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, "No current documentary state found for this CIS.", undefined, undefined, assessmentPayload);
      }

      if (current.status !== OfficialDocumentStatus.AVAILABLE) {
        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, `Document current status is ${current.status}.`, currentPayload, undefined, assessmentPayload);
      }

      const targetVersionId = options.versionId?.trim() || current.currentVersionId;
      if (!targetVersionId) {
        return fail("CURRENT_VERSION_MISSING", cis, options.documentType, "Current documentary state has no currentVersionId.", currentPayload, undefined, assessmentPayload);
      }

      const version = await this.prisma.officialDocumentVersion.findFirst({
        where: {
          id: targetVersionId,
          cis,
          documentType: options.documentType,
        },
        select: {
          id: true,
          contentHash: true,
          cleanHash: true,
          fetchedAt: true,
          createdAt: true,
        },
      });

      if (!version) {
        return fail("VERSION_NOT_FOUND", cis, options.documentType, `Version ${targetVersionId} not found for this CIS/documentType.`, currentPayload, undefined, assessmentPayload);
      }

      const sections = await this.prisma.officialDocumentSection.findMany({
        where: { versionId: version.id },
        select: {
          sectionKey: true,
          title: true,
          position: true,
          contentHash: true,
          content: true,
          metadataJson: true,
        },
        orderBy: { position: "asc" },
      });

      if (sections.length === 0) {
        return fail("SECTIONS_NOT_FOUND", cis, options.documentType, "No derived sections found for this version.", currentPayload, mapVersion(version), assessmentPayload);
      }

      const previewChars = normalizePreviewChars(options.previewChars);
      const sectionPayloads = sections.map((section) => mapSection(section, {
        includeContent: options.includeContent ?? false,
        previewChars,
      }));

      return {
        ok: true,
        cis,
        documentType: options.documentType,
        current: currentPayload,
        version: mapVersion(version),
        assessment: assessmentPayload,
        sections: sectionPayloads,
        sectionCount: sectionPayloads.length,
        missingExpectedSections: extractMissingExpectedSections(sections),
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

function mapCurrent(current: CurrentRecord | null): DocumentSectionReadCurrentPayload | undefined {
  if (!current) return undefined;
  return {
    status: current.status,
    currentVersionId: current.currentVersionId,
    contentHash: current.contentHash,
    sourceUrl: current.sourceUrl,
    lastSeenAt: current.lastSeenAt.toISOString(),
  };
}

function mapVersion(version: VersionRecord): DocumentSectionReadVersionPayload {
  return {
    id: version.id,
    contentHash: version.contentHash,
    cleanHash: version.cleanHash,
    fetchedAt: version.fetchedAt.toISOString(),
    createdAt: version.createdAt.toISOString(),
  };
}

function mapAssessment(assessment: AssessmentRecord | null): DocumentSectionReadAssessmentPayload | undefined {
  if (!assessment) return undefined;
  return {
    status: assessment.status,
    reasonCode: assessment.reasonCode,
    assessedAt: assessment.assessedAt.toISOString(),
  };
}

function mapSection(
  section: SectionRecord,
  options: { includeContent: boolean; previewChars: number },
): DocumentSectionReadSectionPayload {
  const content = typeof section.content === "string" ? section.content : "";
  const payload: DocumentSectionReadSectionPayload = {
    sectionKey: section.sectionKey,
    title: section.title,
    position: section.position,
    contentHash: section.contentHash,
    contentPreview: content.slice(0, options.previewChars),
    contentLength: content.length,
    metadataJson: section.metadataJson ?? {},
  };
  if (options.includeContent) {
    payload.content = content;
  }
  return payload;
}

function extractMissingExpectedSections(sections: SectionRecord[]): string[] {
  for (const section of sections) {
    const metadata = section.metadataJson;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const candidate = (metadata as Record<string, unknown>).missingExpectedSections;
    if (Array.isArray(candidate)) {
      return candidate.filter((value): value is string => typeof value === "string");
    }
  }
  return [];
}

function fail(
  errorCode: DocumentSectionReadErrorCode,
  cis: string,
  documentType: DocumentType,
  errorMessage: string,
  current?: DocumentSectionReadCurrentPayload,
  version?: DocumentSectionReadVersionPayload,
  assessment?: DocumentSectionReadAssessmentPayload,
): DocumentSectionReadPayload {
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
