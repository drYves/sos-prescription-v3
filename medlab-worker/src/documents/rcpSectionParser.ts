import type { Prisma } from "@prisma/client";
import { sha256Hex } from "./documentHashing";

export type RcpSectionKey =
  | "identification_document"
  | "composition"
  | "indications"
  | "posologie"
  | "contre_indications";

export type RcpSectionParseErrorCode =
  | "CLEAN_CONTENT_MISSING"
  | "PARSE_INSUFFICIENT"
  | "PARSE_AMBIGUOUS";

export interface ParsedRcpSection {
  sectionKey: RcpSectionKey;
  title: string;
  position: number;
  content: string;
  contentHash: string;
  metadataJson: Prisma.InputJsonValue;
}

export interface RcpSectionParseSuccess {
  ok: true;
  parserVersion: string;
  sections: ParsedRcpSection[];
  sectionCount: number;
  missingExpectedSections: RcpSectionKey[];
}

export interface RcpSectionParseFailure {
  ok: false;
  parserVersion: string;
  errorCode: RcpSectionParseErrorCode;
  errorMessage: string;
  missingExpectedSections: RcpSectionKey[];
}

export type RcpSectionParseResult = RcpSectionParseSuccess | RcpSectionParseFailure;

interface HeadingMatch {
  index: number;
  heading: string;
}

const EXTRACTION_STRATEGY = "rcp_heading_slice_v1";
const EXPECTED_KEYS: RcpSectionKey[] = [
  "identification_document",
  "composition",
  "indications",
  "posologie",
  "contre_indications",
];

const RCP_TITLE_RE = /^\s*R[ée]sum[ée]\s+des\s+Caract[ée]ristiques\s+du\s+Produit\s*$/gimu;
const DENOMINATION_RE = /^\s*1\s*\.?\s*DENOMINATION\s+DU\s+MEDICAMENT\s*$/gimu;
const COMPOSITION_RE = /^\s*2\s*\.?\s*COMPOSITION\s+QUALITATIVE\s+ET\s+QUANTITATIVE\s*$/gimu;
const SECTION3_RE = /^\s*3\s*\.?\s*[A-ZÉÈÊÀÂÎÏÔÙÛÇ]/gimu;
const INDICATIONS_RE = /^\s*4\s*\.?\s*1\s*\.?\s*Indications\s+th[ée]rapeutiques\s*$/gimu;
const POSOLOGIE_RE = /^\s*4\s*\.?\s*2\s*\.?\s*Posologie\s+et\s+mode\s+d['’]administration\s*$/gimu;
const CONTRE_RE = /^\s*4\s*\.?\s*3\s*\.?\s*Contre[\-\u2010-\u2015 ]indications\s*$/gimu;
const SECTION44_RE = /^\s*4\s*\.?\s*4\s*\.?\s*[A-ZÉÈÊÀÂÎÏÔÙÛÇ]/gimu;

export function parseRcpSections(
  cleanContent: string | null | undefined,
  options: { versionId: string; parserVersion: string },
): RcpSectionParseResult {
  const source = typeof cleanContent === "string" ? cleanContent.trim() : "";
  if (source === "") {
    return {
      ok: false,
      parserVersion: options.parserVersion,
      errorCode: "CLEAN_CONTENT_MISSING",
      errorMessage: "OfficialDocumentVersion.cleanContent is empty.",
      missingExpectedSections: [...EXPECTED_KEYS],
    };
  }

  const rcpTitleMatches = findMatches(source, RCP_TITLE_RE);
  const denominationMatches = findMatches(source, DENOMINATION_RE);
  const compositionMatches = findMatches(source, COMPOSITION_RE);
  const indicationsMatches = findMatches(source, INDICATIONS_RE);
  const posologieMatches = findMatches(source, POSOLOGIE_RE);
  const contreMatches = findMatches(source, CONTRE_RE);

  if (isAmbiguous(rcpTitleMatches, 1)
    || isAmbiguous(denominationMatches, 1)
    || isAmbiguous(compositionMatches, 1)
    || isAmbiguous(indicationsMatches, 1)
    || isAmbiguous(posologieMatches, 1)
    || isAmbiguous(contreMatches, 1)) {
    return {
      ok: false,
      parserVersion: options.parserVersion,
      errorCode: "PARSE_AMBIGUOUS",
      errorMessage: "One or more expected RCP headings matched ambiguously.",
      missingExpectedSections: computeMissing({
        identification_document: rcpTitleMatches.length > 0 || denominationMatches.length > 0,
        composition: compositionMatches.length > 0,
        indications: indicationsMatches.length > 0,
        posologie: posologieMatches.length > 0,
        contre_indications: contreMatches.length > 0,
      }),
    };
  }

  const sections: ParsedRcpSection[] = [];

  const composition = compositionMatches[0];
  const identificationStart = rcpTitleMatches[0] ?? denominationMatches[0];
  if (identificationStart && composition && identificationStart.index < composition.index) {
    const identification = sliceSection(
      source,
      "identification_document",
      identificationStart,
      composition.index,
      1,
      options,
    );
    if (identification) sections.push(identification);
  }

  const section3 = findFirstAfter(source, SECTION3_RE, composition?.index ?? 0);
  if (composition && section3 && composition.index < section3.index) {
    const parsed = sliceSection(source, "composition", composition, section3.index, 2, options);
    if (parsed) sections.push(parsed);
  }

  const indications = indicationsMatches[0];
  const posologie = posologieMatches[0];
  if (indications && posologie && indications.index < posologie.index) {
    const parsed = sliceSection(source, "indications", indications, posologie.index, 3, options);
    if (parsed) sections.push(parsed);
  }

  const contre = contreMatches[0];
  if (posologie && contre && posologie.index < contre.index) {
    const parsed = sliceSection(source, "posologie", posologie, contre.index, 4, options);
    if (parsed) sections.push(parsed);
  }

  const section44 = findFirstAfter(source, SECTION44_RE, contre?.index ?? 0);
  if (contre) {
    const endIndex = section44?.index ?? source.length;
    if (contre.index < endIndex) {
      const parsed = sliceSection(source, "contre_indications", contre, endIndex, 5, options);
      if (parsed) sections.push(parsed);
    }
  }

  const foundKeys = new Set(sections.map((section) => section.sectionKey));
  const missingExpectedSections = EXPECTED_KEYS.filter((key) => !foundKeys.has(key));
  const nonIdentificationCount = sections.filter((section) => section.sectionKey !== "identification_document").length;

  if (!foundKeys.has("identification_document") || nonIdentificationCount < 2) {
    return {
      ok: false,
      parserVersion: options.parserVersion,
      errorCode: "PARSE_INSUFFICIENT",
      errorMessage: "RCP parsing did not yield the minimum required sections.",
      missingExpectedSections,
    };
  }

  return {
    ok: true,
    parserVersion: options.parserVersion,
    sections,
    sectionCount: sections.length,
    missingExpectedSections,
  };
}

function sliceSection(
  source: string,
  sectionKey: RcpSectionKey,
  start: HeadingMatch,
  endIndex: number,
  position: number,
  options: { versionId: string; parserVersion: string },
): ParsedRcpSection | null {
  const raw = source.slice(start.index, endIndex).trim();
  if (raw === "") return null;
  const title = firstNonEmptyLine(raw) ?? start.heading.trim();
  return {
    sectionKey,
    title,
    position,
    content: raw,
    contentHash: sha256Hex(raw),
    metadataJson: {
      extractionStrategy: EXTRACTION_STRATEGY,
      matchedHeading: start.heading.trim(),
      sourceVersionId: options.versionId,
      parserVersion: options.parserVersion,
    },
  };
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function findMatches(source: string, pattern: RegExp): HeadingMatch[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  const matches: HeadingMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    matches.push({
      index: match.index,
      heading: match[0],
    });
  }
  return matches;
}

function findFirstAfter(source: string, pattern: RegExp, afterIndex: number): HeadingMatch | undefined {
  return findMatches(source, pattern).find((match) => match.index > afterIndex);
}

function isAmbiguous(matches: HeadingMatch[], maxAllowed: number): boolean {
  return matches.length > maxAllowed;
}

function computeMissing(found: Record<RcpSectionKey, boolean>): RcpSectionKey[] {
  return EXPECTED_KEYS.filter((key) => !found[key]);
}
