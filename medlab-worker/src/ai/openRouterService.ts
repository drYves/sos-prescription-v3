// src/ai/openRouterService.ts
import { NdjsonLogger } from "../logger";

export interface OpenRouterServiceConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  httpReferer?: string;
  title?: string;
  logger?: NdjsonLogger;
}

export interface AnalyzeArtifactInput {
  artifactId: string;
  mimeType: string;
  originalName: string;
  data: Buffer;
}

export interface AnalyzeMedication {
  label: string;
  scheduleText: string;
}

export interface AnalyzeArtifactResult {
  is_prescription: boolean;
  reasoning: string;
  medications: AnalyzeMedication[];
  provider?: string;
  model?: string;
}

type OpenRouterChatResponse = {
  id?: string;
  provider?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
};

export class OpenRouterService {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly httpReferer?: string;
  private readonly title?: string;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: OpenRouterServiceConfig) {
    this.apiKey = normalizeOptionalString(cfg.apiKey);
    this.model = normalizeRequiredString(cfg.model, "model");
    this.baseUrl = normalizeRequiredString(cfg.baseUrl, "baseUrl");
    this.requestTimeoutMs = Math.max(5_000, Math.floor(cfg.requestTimeoutMs || 45_000));
    this.httpReferer = normalizeOptionalString(cfg.httpReferer);
    this.title = normalizeOptionalString(cfg.title);
    this.logger = cfg.logger;
  }

  isEnabled(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async analyzeArtifact(input: AnalyzeArtifactInput): Promise<AnalyzeArtifactResult> {
    if (!this.isEnabled()) {
      throw new Error("ML_AI_DISABLED");
    }

    const artifactId = normalizeRequiredString(input.artifactId, "artifactId");
    const mimeType = normalizeRequiredString(input.mimeType, "mimeType").toLowerCase();
    const originalName = normalizeRequiredString(input.originalName || "document.bin", "originalName");
    const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);

    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const userContent = buildUserContentParts(mimeType, originalName, dataUrl);

    const requestPayload: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "prescription_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["is_prescription", "reasoning", "medications"],
            properties: {
              is_prescription: { type: "boolean" },
              reasoning: { type: "string" },
              medications: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "scheduleText"],
                  properties: {
                    label: { type: "string" },
                    scheduleText: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      temperature: 0,
      max_tokens: 800,
    };

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: buildHeaders(this.apiKey as string, this.httpReferer, this.title),
        body: JSON.stringify(requestPayload),
      });

      const raw = await response.text();
      let payload: OpenRouterChatResponse | null = null;
      try {
        payload = raw ? (JSON.parse(raw) as OpenRouterChatResponse) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message = payload?.error?.message || payload?.error?.code || `OpenRouter HTTP ${response.status}`;
        this.logger?.error(
          "ai.openrouter.failed",
          {
            artifact_id: artifactId,
            model: this.model,
            status_code: response.status,
            reason: message,
          },
          undefined,
        );
        throw new Error(`ML_AI_UPSTREAM_FAILED:${message}`);
      }

      const content = extractAssistantContent(payload);
      const parsed = parseStructuredAnalysis(content);
      const result: AnalyzeArtifactResult = {
        is_prescription: !!parsed.is_prescription,
        reasoning: normalizeOptionalString(parsed.reasoning) ?? "",
        medications: normalizeMedications(parsed.medications),
        provider: normalizeOptionalString(payload?.provider),
        model: normalizeOptionalString(payload?.model) ?? this.model,
      };

      this.logger?.info(
        "ai.openrouter.completed",
        {
          artifact_id: artifactId,
          model: result.model ?? this.model,
          provider: result.provider,
          is_prescription: result.is_prescription,
          medications_count: result.medications.length,
        },
        undefined,
      );

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "ML_AI_FAILED";
      if (message === "ML_AI_DISABLED") {
        throw err;
      }

      if (err instanceof Error && err.name === "AbortError") {
        this.logger?.error(
          "ai.openrouter.timeout",
          {
            artifact_id: artifactId,
            model: this.model,
            timeout_ms: this.requestTimeoutMs,
          },
          undefined,
        );
        throw new Error("ML_AI_TIMEOUT");
      }

      if (!String(message).startsWith("ML_AI_UPSTREAM_FAILED:")) {
        this.logger?.error(
          "ai.openrouter.failed",
          {
            artifact_id: artifactId,
            model: this.model,
            reason: message,
          },
          undefined,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildHeaders(apiKey: string, httpReferer?: string, title?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (httpReferer) {
    headers["HTTP-Referer"] = httpReferer;
  }
  if (title) {
    headers["X-OpenRouter-Title"] = title;
  }
  return headers;
}

function buildUserContentParts(mimeType: string, originalName: string, dataUrl: string): Array<Record<string, unknown>> {
  const prompt = [
    "Analyse ce document médical et réponds UNIQUEMENT avec un JSON valide.",
    "Détermine s'il s'agit d'une prescription médicale lisible ou d'une photo exploitable d'une boîte de médicament.",
    "Si le document ne montre aucune prescription médicale lisible ni aucune boîte de médicament identifiable, retourne is_prescription=false.",
    "Si le document est exploitable, retourne is_prescription=true et liste les médicaments détectés.",
    "Le format attendu est exactement : {\"is_prescription\": boolean, \"reasoning\": string, \"medications\": [{\"label\": string, \"scheduleText\": string}] }.",
    "Ne mets aucun texte hors JSON.",
  ].join(" ");

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: prompt,
    },
  ];

  if (mimeType === "application/pdf") {
    content.push({
      type: "file",
      file: {
        filename: originalName,
        file_data: dataUrl,
      },
    });
    return content;
  }

  if (!mimeType.startsWith("image/")) {
    throw new Error("ML_AI_UNSUPPORTED_MIME");
  }

  content.push({
    type: "image_url",
    image_url: {
      url: dataUrl,
      detail: "high",
    },
  });

  return content;
}

function extractAssistantContent(payload: OpenRouterChatResponse | null): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && "text" in entry && typeof (entry as { text?: unknown }).text === "string") {
          return String((entry as { text: string }).text);
        }
        return "";
      })
      .filter((entry) => entry.trim() !== "");

    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  throw new Error("ML_AI_EMPTY_RESPONSE");
}

function parseStructuredAnalysis(rawContent: string): Record<string, unknown> {
  const text = stripMarkdownFences(rawContent).trim();
  const candidates = [text, extractBalancedJsonObject(text)].filter((value): value is string => typeof value === "string" && value.trim() !== "");

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error("ML_AI_BAD_JSON");
}

function stripMarkdownFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }

  return null;
}

function normalizeMedications(value: unknown): AnalyzeMedication[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: AnalyzeMedication[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const label = normalizeOptionalString(row.label);
    const scheduleText = normalizeOptionalString(row.scheduleText) ?? "";
    if (!label) {
      continue;
    }
    out.push({
      label,
      scheduleText,
    });
    if (out.length >= 20) {
      break;
    }
  }
  return out;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}
