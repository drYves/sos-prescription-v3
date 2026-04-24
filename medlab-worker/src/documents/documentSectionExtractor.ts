import {
  DocumentPublicationStatus,
  DocumentType,
  OfficialDocumentStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { normalizeCis } from "./bdpmOfficialDocumentSource";
import {
  parseRcpSections,
  type ParsedRcpSection,
  type RcpSectionKey,
  type RcpSectionParseErrorCode,
} from "./rcpSectionParser";

export type DocumentSectionErrorCode =
  | "CIS_NOT_FOUND"
  | "DOCUMENT_TYPE_UNSUPPORTED"
  | "DOCUMENT_NOT_INGESTED"
  | "CURRENT_VERSION_MISSING"
  | "VERSION_NOT_FOUND"
  | "DOCUMENT_BLOCKED"
  | "DOCUMENT_NEEDS_REVIEW"
  | "CLEAN_CONTENT_MISSING"
  | "PARSE_INSUFFICIENT"
  | "PARSE_AMBIGUOUS"
  | "SECTION_PERSIST_FAILED"
  | "READ_FAILED";

export interface DocumentSectionExtractorOptions {
  cis: string;
  documentType: DocumentType;
  versionId?: string;
  dryRun?: boolean;
  includeContent?: boolean;
  parserVersion?: string;
}

export interface DocumentSectionPayload {
  ok: boolean;
  cis: string;
  documentType: DocumentType;
  versionId?: string;
  dryRun: boolean;
  parserVersion: string;
  sections?: DocumentSectionSummary[];
  sectionCount?: number;
  missingExpectedSections: RcpSectionKey[];
  errorCode?: DocumentSectionErrorCode;
  errorMessage?: string;
  current?: DocumentSectionCurrentPayload;
  assessment?: DocumentSectionAssessmentPayload;
}

export interface DocumentSectionSummary {
  sectionKey: RcpSectionKey;
  title: string;
  position: number;
  contentHash: string;
  contentLength: number;
  content?: string;
}

export interface DocumentSectionCurrentPayload {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  sourceUrl: string;
}

export interface DocumentSectionAssessmentPayload {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: string;
}

const DEFAULT_PARSER_VERSION = "rcp-lot3-v1";

interface CurrentRecord {
  status: OfficialDocumentStatus;
  currentVersionId: string | null;
  sourceUrl: string;
}

interface AssessmentRecord {
  status: DocumentPublicationStatus;
  reasonCode: string | null;
  assessedAt: Date;
}

interface VersionRecord {
  id: string;
  cis: string;
  documentType: DocumentType;
  cleanContent: string | null;
}

export class DocumentSectionExtractor {
  constructor(private readonly prisma: PrismaClient) {}

  async extract(options: DocumentSectionExtractorOptions): Promise<DocumentSectionPayload> {
    const parserVersion = normalizeParserVersion(options.parserVersion);
    const dryRun = options.dryRun ?? false;
    const includeContent = options.includeContent ?? false;

    let cis: string;
    try {
      cis = normalizeCis(options.cis);
    } catch (err) {
      return fail("READ_FAILED", options.cis, options.documentType, dryRun, parserVersion, [], err instanceof Error ? err.message : String(err));
    }

    try {
      if (options.documentType !== DocumentType.RCP) {
        return fail("DOCUMENT_TYPE_UNSUPPORTED", cis, options.documentType, dryRun, parserVersion, [], "Lot 3 supports RCP only.");
      }

      const medication = await this.prisma.bdpmMedication.findUnique({
        where: { cis },
        select: { cis: true },
      });
      if (!medication) {
        return fail("CIS_NOT_FOUND", cis, options.documentType, dryRun, parserVersion, [], `CIS ${cis} not found in BdpmMedication.`);
      }

      const [current, assessment] = await Promise.all([
        this.prisma.officialDocumentCurrent.findUnique({
          where: { cis_documentType: { cis, documentType: options.documentType } },
          select: {
            status: true,
            currentVersionId: true,
            sourceUrl: true,
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
        return fail("DOCUMENT_BLOCKED", cis, options.documentType, dryRun, parserVersion, [], "Document blocked for section extraction.", currentPayload, assessmentPayload);
      }

      if (assessment?.status === DocumentPublicationStatus.NEEDS_REVIEW && (!current || current.status !== OfficialDocumentStatus.AVAILABLE)) {
        return fail("DOCUMENT_NEEDS_REVIEW", cis, options.documentType, dryRun, parserVersion, [], "Document requires review before section extraction.", currentPayload, assessmentPayload);
      }

      if (!current) {
        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, dryRun, parserVersion, [], "No current documentary state found for this CIS.", undefined, assessmentPayload);
      }

      if (current.status !== OfficialDocumentStatus.AVAILABLE) {
        return fail("DOCUMENT_NOT_INGESTED", cis, options.documentType, dryRun, parserVersion, [], `Document current status is ${current.status}.`, currentPayload, assessmentPayload);
      }

      const targetVersionId = options.versionId?.trim() || current.currentVersionId;
      if (!targetVersionId) {
        return fail("CURRENT_VERSION_MISSING", cis, options.documentType, dryRun, parserVersion, [], "Current documentary state has no currentVersionId.", currentPayload, assessmentPayload);
      }

      const version = await this.prisma.officialDocumentVersion.findFirst({
        where: {
          id: targetVersionId,
          cis,
          documentType: options.documentType,
        },
        select: {
          id: true,
          cis: true,
          documentType: true,
          cleanContent: true,
        },
      });

      if (!version) {
        return fail("VERSION_NOT_FOUND", cis, options.documentType, dryRun, parserVersion, [], `Version ${targetVersionId} not found for this CIS/documentType.`, currentPayload, assessmentPayload);
      }

      const parsed = parseRcpSections(version.cleanContent, {
        versionId: version.id,
        parserVersion,
      });

      if (!parsed.ok) {
        return fail(mapParseError(parsed.errorCode), cis, options.documentType, dryRun, parserVersion, parsed.missingExpectedSections, parsed.errorMessage, currentPayload, assessmentPayload, version.id);
      }

      if (!dryRun) {
        try {
          await this.prisma.$transaction([
            this.prisma.officialDocumentSection.deleteMany({
              where: { versionId: version.id },
            }),
            this.prisma.officialDocumentSection.createMany({
              data: parsed.sections.map((section) => ({
                versionId: version.id,
                sectionKey: section.sectionKey,
                title: section.title,
                position: section.position,
                content: section.content,
                contentHash: section.contentHash,
                metadataJson: section.metadataJson,
              })),
            }),
          ]);
        } catch (err) {
          return fail("SECTION_PERSIST_FAILED", cis, options.documentType, dryRun, parserVersion, parsed.missingExpectedSections, err instanceof Error ? err.message : String(err), currentPayload, assessmentPayload, version.id);
        }
      }

      return {
        ok: true,
        cis,
        documentType: options.documentType,
        versionId: version.id,
        dryRun,
        parserVersion,
        sections: parsed.sections.map((section) => summarizeSection(section, includeContent)),
        sectionCount: parsed.sectionCount,
        missingExpectedSections: parsed.missingExpectedSections,
        current: currentPayload,
        assessment: assessmentPayload,
      };
    } catch (err) {
      return fail("READ_FAILED", cis, options.documentType, dryRun, parserVersion, [], err instanceof Error ? err.message : String(err));
    }
  }
}

function normalizeParserVersion(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DEFAULT_PARSER_VERSION;
}

function summarizeSection(section: ParsedRcpSection, includeContent: boolean): DocumentSectionSummary {
  const summary: DocumentSectionSummary = {
    sectionKey: section.sectionKey,
    title: section.title,
    position: section.position,
    contentHash: section.contentHash,
    contentLength: section.content.length,
  };
  if (includeContent) {
    summary.content = section.content;
  }
  return summary;
}

function mapCurrent(current: CurrentRecord | null): DocumentSectionCurrentPayload | undefined {
  if (!current) return undefined;
  return {
    status: current.status,
    currentVersionId: current.currentVersionId,
    sourceUrl: current.sourceUrl,
  };
}

function mapAssessment(assessment: AssessmentRecord | null): DocumentSectionAssessmentPayload | undefined {
  if (!assessment) return undefined;
  return {
    status: assessment.status,
    reasonCode: assessment.reasonCode,
    assessedAt: assessment.assessedAt.toISOString(),
  };
}

function mapParseError(errorCode: RcpSectionParseErrorCode): DocumentSectionErrorCode {
  switch (errorCode) {
    case "CLEAN_CONTENT_MISSING":
      return "CLEAN_CONTENT_MISSING";
    case "PARSE_AMBIGUOUS":
      return "PARSE_AMBIGUOUS";
    case "PARSE_INSUFFICIENT":
    default:
      return "PARSE_INSUFFICIENT";
  }
}

function fail(
  errorCode: DocumentSectionErrorCode,
  cis: string,
  documentType: DocumentType,
  dryRun: boolean,
  parserVersion: string,
  missingExpectedSections: RcpSectionKey[],
  errorMessage: string,
  current?: DocumentSectionCurrentPayload,
  assessment?: DocumentSectionAssessmentPayload,
  versionId?: string,
): DocumentSectionPayload {
  return {
    ok: false,
    cis,
    documentType,
    versionId,
    dryRun,
    parserVersion,
    missingExpectedSections,
    errorCode,
    errorMessage,
    current,
    assessment,
  };
}
