export interface NormalizedRcpDocument {
  rawContent: string;
  cleanContent: string;
  officialUpdatedAt?: Date;
  extractionStrategy: string;
}

const RCP_TITLE_RE = /Résumé\s+des\s+Caractéristiques\s+du\s+Produit/i;
const ANSM_UPDATED_RE = /ANSM\s*-\s*Mis\s+à\s+jour\s+le\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i;
const NOTICE_TITLE_RE = /\bNotice\s+patient\b/i;
const NOTICE_SUMMARY_RE = /Sommaire\s+de\s+la\s+notice/i;
const IMPORTANT_INFO_RE = /Informations\s+importantes/i;

export function extractAndNormalizeRcp(rawHtml: string): NormalizedRcpDocument {
  const rawText = htmlToStableText(rawHtml);
  const updatedMatch = ANSM_UPDATED_RE.exec(rawText);
  if (!updatedMatch || updatedMatch.index === undefined) {
    throw new Error("RCP_ANSM_UPDATED_MARKER_NOT_FOUND");
  }

  const prefix = rawText.slice(0, updatedMatch.index);
  const titleMatchIndex = findLastMatchIndex(prefix, RCP_TITLE_RE);
  if (titleMatchIndex < 0) {
    throw new Error("RCP_TITLE_MARKER_NOT_FOUND");
  }

  const afterUpdated = updatedMatch.index + updatedMatch[0].length;
  const end = findRcpEndIndex(rawText, afterUpdated);
  if (end <= afterUpdated) {
    throw new Error("RCP_END_MARKER_NOT_FOUND");
  }

  const rawContent = normalizeLineEndings(rawText.slice(titleMatchIndex, end)).trim();
  const cleanContent = stabilizeWhitespace(rawContent);
  if (cleanContent.length < 200) {
    throw new Error("RCP_CONTENT_TOO_SHORT");
  }

  return {
    rawContent,
    cleanContent,
    officialUpdatedAt: parseFrenchDate(updatedMatch[1], updatedMatch[2], updatedMatch[3]),
    extractionStrategy: "bdpm_extrait_text_between_rcp_title_and_notice_summary_or_notice_patient",
  };
}

function findRcpEndIndex(text: string, searchStart: number): number {
  const candidates = [
    findNextMatchIndex(text, IMPORTANT_INFO_RE, searchStart),
    findNextMatchIndex(text, NOTICE_SUMMARY_RE, searchStart),
    findNextMatchIndex(text, NOTICE_TITLE_RE, searchStart),
  ].filter((idx) => idx >= 0);

  if (candidates.length === 0) {
    return text.length;
  }

  return Math.min(...candidates);
}

function htmlToStableText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n");

  const blockSeparated = withoutScripts
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|table|thead|tbody|tr|td|th|h[1-6])\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(blockSeparated)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stabilizeWhitespace(content: string): string {
  return normalizeLineEndings(content)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function findLastMatchIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match.index;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return last;
}

function findNextMatchIndex(text: string, pattern: RegExp, start: number): number {
  const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const match = re.exec(text.slice(start));
  return match ? start + match.index : -1;
}

function parseFrenchDate(day: string, month: string, year: string): Date | undefined {
  const iso = `${year}-${month}-${day}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    eacute: "é",
    egrave: "è",
    ecirc: "ê",
    agrave: "à",
    acirc: "â",
    ccedil: "ç",
    ugrave: "ù",
    ocirc: "ô",
    icirc: "î",
    iuml: "ï",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, raw: string) => {
    const lower = raw.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return named[lower] ?? entity;
  });
}
