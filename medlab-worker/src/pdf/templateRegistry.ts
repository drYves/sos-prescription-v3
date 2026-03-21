// src/pdf/templateRegistry.ts
import fsp from "node:fs/promises";
import path from "node:path";

export type TemplateVariant = "standard" | "modern" | "minimal";

export interface TemplateRecord {
  variant: TemplateVariant;
  fileName: string;
  templateName: string;
  absolutePath: string;
  html: string;
}

export interface TemplateRegistryConfig {
  baseDir?: string;
}

const TEMPLATE_FILES: Record<TemplateVariant, string> = {
  standard: "rx-ordonnance-mpdf.html",
  modern: "rx-ordonnance-modern.html",
  minimal: "rx-ordonnance-minimal.html",
};

export class TemplateRegistry {
  private readonly baseDirOverride?: string;
  private readonly cache = new Map<TemplateVariant, TemplateRecord>();

  constructor(cfg: TemplateRegistryConfig = {}) {
    this.baseDirOverride = cfg.baseDir;
  }

  async getTemplate(variant: string | null | undefined): Promise<TemplateRecord> {
    const normalized = normalizeTemplateVariant(variant);
    const cached = this.cache.get(normalized);
    if (cached) {
      return cached;
    }

    const baseDir = await this.resolveTemplateDir();
    const fileName = TEMPLATE_FILES[normalized];
    const absolutePath = path.join(baseDir, fileName);
    const html = await fsp.readFile(absolutePath, "utf8");

    if (html.trim() === "") {
      throw new Error(`Template is empty: ${absolutePath}`);
    }

    const record: TemplateRecord = {
      variant: normalized,
      fileName,
      templateName: fileName,
      absolutePath,
      html,
    };

    this.cache.set(normalized, record);
    return record;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async resolveTemplateDir(): Promise<string> {
    const candidates = [
      this.baseDirOverride,
      process.env.ML_PDF_TEMPLATE_DIR,
      path.resolve(process.cwd(), "templates"),
      path.resolve(__dirname, "../../templates"),
      path.resolve(__dirname, "../templates"),
    ].filter((value): value is string => typeof value === "string" && value.trim() !== "");

    for (const candidate of candidates) {
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isDirectory()) {
          return candidate;
        }
      } catch (_err) {
        // noop
      }
    }

    throw new Error("PDF template directory not found. Set ML_PDF_TEMPLATE_DIR or provide templates/ at repo root.");
  }
}

export function normalizeTemplateVariant(value: string | null | undefined): TemplateVariant {
  const raw = String(value ?? "").trim().toLowerCase();

  if (
    raw === "standard"
    || raw === "default"
    || raw === "mpdf"
    || raw === TEMPLATE_FILES.standard
  ) {
    return "standard";
  }

  if (raw === "minimal" || raw === TEMPLATE_FILES.minimal) {
    return "minimal";
  }

  return "modern";
}
