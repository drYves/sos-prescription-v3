"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterService = void 0;
const FALLBACK_MODELS = [
    "google/gemini-2.5-flash",
    "anthropic/claude-3.5-sonnet",
];
class OpenRouterService {
    apiKey;
    model;
    baseUrl;
    requestTimeoutMs;
    httpReferer;
    title;
    logger;
    constructor(cfg) {
        this.apiKey = normalizeOptionalString(cfg.apiKey);
        this.model = normalizeRequiredString(cfg.model, "model");
        this.baseUrl = normalizeRequiredString(cfg.baseUrl, "baseUrl");
        this.requestTimeoutMs = Math.max(5_000, Math.floor(cfg.requestTimeoutMs || 45_000));
        this.httpReferer = normalizeOptionalString(cfg.httpReferer);
        this.title = normalizeOptionalString(cfg.title);
        this.logger = cfg.logger;
    }
    isEnabled() {
        return typeof this.apiKey === "string" && this.apiKey.length > 0;
    }
    async analyzeArtifact(input) {
        if (!this.isEnabled()) {
            throw new Error("ML_AI_DISABLED");
        }
        const artifactId = normalizeRequiredString(input.artifactId, "artifactId");
        const mimeType = normalizeRequiredString(input.mimeType, "mimeType").toLowerCase();
        const originalName = normalizeRequiredString(input.originalName || "document.bin", "originalName");
        const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
        const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
        const userContent = buildUserContentParts(mimeType, originalName, dataUrl);
        const candidateModels = buildCandidateModels(this.model);
        let lastError = null;
        for (let index = 0; index < candidateModels.length; index += 1) {
            const candidateModel = candidateModels[index];
            try {
                const attempt = await this.requestStructuredAnalysis({
                    artifactId,
                    model: candidateModel,
                    userContent,
                });
                const result = {
                    ...attempt.result,
                    provider: attempt.provider,
                    model: attempt.model ?? candidateModel,
                };
                this.logger?.info("ai.openrouter.completed", {
                    artifact_id: artifactId,
                    model: result.model ?? candidateModel,
                    provider: result.provider,
                    is_prescription: result.is_prescription,
                    medications_count: result.medications.length,
                }, undefined);
                return result;
            }
            catch (err) {
                lastError = err;
                const message = err instanceof Error ? err.message : "ML_AI_FAILED";
                const nextModel = candidateModels[index + 1];
                if (nextModel && shouldRetryWithFallback(message, candidateModel)) {
                    this.logger?.warning("ai.openrouter.retry_model", {
                        artifact_id: artifactId,
                        from_model: candidateModel,
                        to_model: nextModel,
                        reason: message,
                    }, undefined);
                    continue;
                }
                throw err;
            }
        }
        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new Error("ML_AI_FAILED");
    }
    async requestStructuredAnalysis(input) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
            controller.abort();
        }, this.requestTimeoutMs);
        const requestPayload = {
            model: input.model,
            messages: [
                {
                    role: "user",
                    content: input.userContent,
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
        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                signal: controller.signal,
                headers: buildHeaders(this.apiKey, this.httpReferer, this.title),
                body: JSON.stringify(requestPayload),
            });
            const raw = await response.text();
            let payload = null;
            try {
                payload = raw ? JSON.parse(raw) : null;
            }
            catch {
                payload = null;
            }
            if (!response.ok) {
                const message = payload?.error?.message || payload?.error?.code || `OpenRouter HTTP ${response.status}`;
                this.logger?.error("ai.openrouter.failed", {
                    artifact_id: input.artifactId,
                    model: input.model,
                    status_code: response.status,
                    reason: message,
                }, undefined);
                throw new Error(`ML_AI_UPSTREAM_FAILED:${message}`);
            }
            const content = extractAssistantContent(payload);
            const parsed = parseStructuredAnalysis(content);
            return {
                result: {
                    is_prescription: !!parsed.is_prescription,
                    reasoning: normalizeOptionalString(parsed.reasoning) ?? "",
                    medications: normalizeMedications(parsed.medications),
                },
                provider: normalizeOptionalString(payload?.provider),
                model: normalizeOptionalString(payload?.model) ?? input.model,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "ML_AI_FAILED";
            if (message === "ML_AI_DISABLED") {
                throw err;
            }
            if (err instanceof Error && err.name === "AbortError") {
                this.logger?.error("ai.openrouter.timeout", {
                    artifact_id: input.artifactId,
                    model: input.model,
                    timeout_ms: this.requestTimeoutMs,
                }, undefined);
                throw new Error("ML_AI_TIMEOUT");
            }
            if (!String(message).startsWith("ML_AI_UPSTREAM_FAILED:")) {
                this.logger?.error("ai.openrouter.failed", {
                    artifact_id: input.artifactId,
                    model: input.model,
                    reason: message,
                }, undefined);
            }
            throw err;
        }
        finally {
            clearTimeout(timeoutHandle);
        }
    }
}
exports.OpenRouterService = OpenRouterService;
function buildCandidateModels(primaryModel) {
    const candidates = [primaryModel, ...FALLBACK_MODELS];
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = normalizeOptionalString(candidate);
        if (!normalized) {
            continue;
        }
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
function shouldRetryWithFallback(message, currentModel) {
    const normalized = String(message || "").toLowerCase();
    if (currentModel === FALLBACK_MODELS[FALLBACK_MODELS.length - 1]) {
        return false;
    }
    return normalized.startsWith("ml_ai_upstream_failed:")
        && (normalized.includes("no endpoints found")
            || normalized.includes("model") && normalized.includes("not found")
            || normalized.includes("unknown model"));
}
function buildHeaders(apiKey, httpReferer, title) {
    const headers = {
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
function buildUserContentParts(mimeType, originalName, dataUrl) {
    const prompt = [
        "Analyse ce document médical et réponds UNIQUEMENT avec un JSON valide.",
        "Détermine s'il s'agit d'une prescription médicale lisible ou d'une photo exploitable d'une boîte de médicament.",
        "Si le document ne montre aucune prescription médicale lisible ni aucune boîte de médicament identifiable, retourne is_prescription=false.",
        "Si le document est exploitable, retourne is_prescription=true et liste les médicaments détectés.",
        'Le format attendu est exactement : {"is_prescription": boolean, "reasoning": string, "medications": [{"label": string, "scheduleText": string}] }.',
        "Ne mets aucun texte hors JSON.",
    ].join(" ");
    const content = [
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
function extractAssistantContent(payload) {
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
            if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
                return String(entry.text);
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
function parseStructuredAnalysis(rawContent) {
    const text = stripMarkdownFences(rawContent).trim();
    const candidates = [text, extractBalancedJsonObject(text)].filter((value) => typeof value === "string" && value.trim() !== "");
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // try next candidate
        }
    }
    throw new Error("ML_AI_BAD_JSON");
}
function stripMarkdownFences(value) {
    return value
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}
function extractBalancedJsonObject(value) {
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
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else if (ch === '"') {
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
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
                return value.slice(start, i + 1);
            }
        }
    }
    return null;
}
function normalizeMedications(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
        }
        const row = entry;
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
function normalizeRequiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${field} is required`);
    }
    return value.trim();
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized === "" ? undefined : normalized;
}
