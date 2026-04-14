"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopilotService = void 0;
const DEFAULT_SMART_REPLY_MAX_CHARS = 220;
const POLISH_SYSTEM_PROMPT = [
    "Tu es un assistant de rédaction médicale.",
    "Ton rôle est de corriger la forme (orthographe, ton professionnel, empathie) sans jamais modifier la substance clinique ou la décision du médecin.",
    "Tu ne changes jamais une décision médicale, un médicament, une posologie, une consigne clinique, un refus, une condition, une urgence ou une orientation.",
    "Si le message est ambigu, incomplet ou cliniquement risqué, tu le signales dans risk_flags et tu reformules en demandant une précision au lieu de deviner.",
    "Réponds uniquement par un objet JSON valide.",
    'Format obligatoire: {"rewritten_body": string, "changes_summary": string[], "risk_flags": string[]}.',
].join(" ");
const SMART_REPLIES_SYSTEM_PROMPT = [
    "Tu es un copilote de messagerie pour médecin.",
    "Tu rédiges trois réponses courtes destinées à un patient, à partir du dernier message patient et du contexte médicamenteux fourni.",
    "Tu n'inventes jamais une décision clinique, un diagnostic, un traitement, une posologie ou un examen.",
    "Tu restes prudent, professionnel, empathique et concret.",
    "Tu dois produire exactement trois options avec les catégories suivantes: clarification, confirmation, refus_poli.",
    "clarification = demander une précision ou un élément manquant.",
    "confirmation = accusé de réception ou validation conditionnelle sans ajouter de nouvelle décision clinique.",
    "refus_poli = refus courtois ou orientation vers une évaluation si la demande dépasse le contexte fourni.",
    "Chaque body doit rester court et directement réutilisable par un médecin.",
    "Réponds uniquement par un objet JSON valide.",
    'Format obligatoire: {"replies": [{"type": "clarification"|"confirmation"|"refus_poli", "title": string, "body": string}], "risk_flags": string[]}.',
].join(" ");
class CopilotService {
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
    async polishMessage(draft, constraints = {}) {
        const sourceDraft = normalizeDraftInput(draft);
        const normalizedConstraints = normalizePolishConstraints(constraints);
        if (sourceDraft === "") {
            return {
                rewritten_body: "",
                changes_summary: ["empty_input"],
                risk_flags: ["EMPTY_DRAFT"],
            };
        }
        if (!this.isEnabled()) {
            return {
                rewritten_body: sourceDraft,
                changes_summary: ["assistant_disabled_original_returned"],
                risk_flags: ["AI_DISABLED"],
            };
        }
        const userPayload = {
            draft: sourceDraft,
            constraints: {
                audience: normalizedConstraints.audience,
                tone: normalizedConstraints.tone,
                language: normalizedConstraints.language,
                max_characters: normalizedConstraints.maxCharacters,
                preserve_decision: normalizedConstraints.preserve_decision,
                force_clarification_if_ambiguous: normalizedConstraints.force_clarification_if_ambiguous,
            },
        };
        const response = await this.requestJson({
            systemPrompt: POLISH_SYSTEM_PROMPT,
            userPayload,
            operation: "copilot.polish_message",
            temperature: 0.1,
            maxTokens: 700,
        });
        const rewritten = normalizeOptionalString(response.parsed.rewritten_body) ?? sourceDraft;
        const result = {
            rewritten_body: applyMaxCharacters(rewritten, normalizedConstraints.maxCharacters),
            changes_summary: normalizeStringArray(response.parsed.changes_summary, 12, "changes_summary_missing"),
            risk_flags: normalizeStringArray(response.parsed.risk_flags, 12),
            provider: response.provider,
            model: response.model,
        };
        if (result.rewritten_body === sourceDraft && !result.changes_summary.includes("no_surface_change_detected")) {
            result.changes_summary.push("no_surface_change_detected");
        }
        return result;
    }
    async generateSmartReplies(input) {
        const normalizedInput = normalizeSmartRepliesInput(input);
        if (!this.isEnabled()) {
            return buildFallbackSmartReplies(normalizedInput, ["AI_DISABLED"]);
        }
        const response = await this.requestJson({
            systemPrompt: SMART_REPLIES_SYSTEM_PROMPT,
            userPayload: {
                patient_message: normalizedInput.patientMessage,
                cis_list: normalizedInput.cisList,
                medication_labels: normalizedInput.medicationLabels,
                thread_preview: normalizedInput.threadPreview,
                max_characters_per_reply: normalizedInput.maxCharactersPerReply,
            },
            operation: "copilot.generate_smart_replies",
            temperature: 0.2,
            maxTokens: 800,
        });
        const replies = normalizeSmartReplyOptions(response.parsed.replies, normalizedInput.maxCharactersPerReply);
        if (replies.length !== 3 || !hasAllReplyTypes(replies)) {
            const fallback = buildFallbackSmartReplies(normalizedInput, ["SMART_REPLY_SCHEMA_RECOVERED"]);
            return {
                replies: fallback.replies,
                risk_flags: mergeUniqueStrings(normalizeStringArray(response.parsed.risk_flags, 12), fallback.risk_flags),
                provider: response.provider,
                model: response.model,
            };
        }
        return {
            replies,
            risk_flags: normalizeStringArray(response.parsed.risk_flags, 12),
            provider: response.provider,
            model: response.model,
        };
    }
    async requestJson(input) {
        if (!this.apiKey) {
            throw new Error("ML_AI_DISABLED");
        }
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => {
            controller.abort();
        }, this.requestTimeoutMs);
        const payload = {
            model: this.model,
            messages: [
                {
                    role: "system",
                    content: input.systemPrompt,
                },
                {
                    role: "user",
                    content: JSON.stringify(input.userPayload),
                },
            ],
            response_format: {
                type: "json_object",
            },
            temperature: input.temperature,
            max_tokens: input.maxTokens,
        };
        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                signal: controller.signal,
                headers: buildHeaders(this.apiKey, this.httpReferer, this.title),
                body: JSON.stringify(payload),
            });
            const rawBody = await response.text();
            let parsedBody = null;
            try {
                parsedBody = rawBody ? JSON.parse(rawBody) : null;
            }
            catch {
                parsedBody = null;
            }
            if (!response.ok) {
                const message = parsedBody?.error?.message || parsedBody?.error?.code || `OpenRouter HTTP ${response.status}`;
                throw new Error(`ML_AI_UPSTREAM_FAILED:${message}`);
            }
            const assistantContent = extractAssistantContent(parsedBody);
            const parsed = parseJsonObject(assistantContent);
            this.logger?.info(`${input.operation}.completed`, {
                provider: parsedBody?.provider,
                model: parsedBody?.model ?? this.model,
            }, undefined);
            return {
                parsed,
                provider: normalizeOptionalString(parsedBody?.provider),
                model: normalizeOptionalString(parsedBody?.model) ?? this.model,
            };
        }
        catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                throw new Error("ML_AI_TIMEOUT");
            }
            throw err;
        }
        finally {
            clearTimeout(timeoutHandle);
        }
    }
}
exports.CopilotService = CopilotService;
function normalizePolishConstraints(input) {
    const out = {
        audience: input.audience ?? "patient",
        tone: input.tone ?? "professional",
        language: normalizeOptionalString(input.language) ?? "fr",
        preserve_decision: input.preserveDecision !== false,
        force_clarification_if_ambiguous: input.forceClarificationIfAmbiguous !== false,
    };
    if (typeof input.maxCharacters === "number" && Number.isFinite(input.maxCharacters) && input.maxCharacters > 0) {
        out.maxCharacters = Math.trunc(input.maxCharacters);
    }
    return out;
}
function normalizeSmartRepliesInput(input) {
    return {
        patientMessage: normalizeDraftInput(input.patientMessage),
        cisList: uniqueCleanStrings(input.cisList ?? [], 20),
        medicationLabels: uniqueCleanStrings(input.medicationLabels ?? [], 20),
        threadPreview: (Array.isArray(input.threadPreview) ? input.threadPreview : [])
            .map((row) => ({
            authorRole: row.authorRole,
            body: normalizeDraftInput(row.body),
        }))
            .filter((row) => row.body !== "")
            .slice(-6),
        maxCharactersPerReply: typeof input.maxCharactersPerReply === "number" && Number.isFinite(input.maxCharactersPerReply) && input.maxCharactersPerReply > 30
            ? Math.trunc(input.maxCharactersPerReply)
            : DEFAULT_SMART_REPLY_MAX_CHARS,
    };
}
function normalizeSmartReplyOptions(value, maxCharacters) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            continue;
        }
        const row = entry;
        const type = normalizeSmartReplyType(row.type);
        const title = normalizeOptionalString(row.title) ?? defaultTitleForType(type);
        const body = applyMaxCharacters(normalizeOptionalString(row.body) ?? "", maxCharacters);
        if (!type || body === "") {
            continue;
        }
        out.push({
            type,
            title,
            body,
        });
    }
    return dedupeReplyTypes(out).slice(0, 3);
}
function dedupeReplyTypes(replies) {
    const out = [];
    const seen = new Set();
    for (const reply of replies) {
        if (seen.has(reply.type)) {
            continue;
        }
        seen.add(reply.type);
        out.push(reply);
    }
    return out;
}
function hasAllReplyTypes(replies) {
    const types = new Set(replies.map((reply) => reply.type));
    return types.has("clarification") && types.has("confirmation") && types.has("refus_poli");
}
function buildFallbackSmartReplies(input, riskFlags = []) {
    const medicationHint = input.medicationLabels[0] ?? input.cisList[0] ?? "le traitement concerné";
    return {
        replies: [
            {
                type: "clarification",
                title: "Clarification",
                body: applyMaxCharacters(`Bonjour, pouvez-vous préciser votre demande concernant ${medicationHint} et, si besoin, joindre l'ordonnance ou indiquer la posologie habituelle ?`, input.maxCharactersPerReply),
            },
            {
                type: "confirmation",
                title: "Confirmation",
                body: applyMaxCharacters(`Bonjour, votre message a bien été reçu concernant ${medicationHint}. Je vérifie votre dossier et je reviens vers vous rapidement.`, input.maxCharactersPerReply),
            },
            {
                type: "refus_poli",
                title: "Refus poli",
                body: applyMaxCharacters(`Bonjour, je ne peux pas confirmer cette demande en l'état. Merci de préciser le contexte ou de transmettre les éléments nécessaires afin que je puisse vous répondre correctement.`, input.maxCharactersPerReply),
            },
        ],
        risk_flags: mergeUniqueStrings(riskFlags, input.patientMessage === "" ? ["EMPTY_PATIENT_MESSAGE"] : []),
    };
}
function normalizeSmartReplyType(value) {
    const normalized = normalizeDraftInput(String(value ?? ""))
        .toLowerCase()
        .replace(/[^a-z_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (normalized === "clarification") {
        return "clarification";
    }
    if (normalized === "confirmation") {
        return "confirmation";
    }
    if (normalized === "refus_poli" || normalized === "refusal_polite" || normalized === "refus") {
        return "refus_poli";
    }
    return null;
}
function defaultTitleForType(type) {
    switch (type) {
        case "clarification":
            return "Clarification";
        case "confirmation":
            return "Confirmation";
        case "refus_poli":
            return "Refus poli";
        default:
            return "Réponse";
    }
}
function normalizeStringArray(value, maxItems = 12, fallbackItem) {
    const source = Array.isArray(value) ? value : [];
    const out = source
        .map((entry) => normalizeOptionalString(entry) ?? "")
        .filter((entry) => entry !== "")
        .slice(0, maxItems);
    if (out.length < 1 && fallbackItem) {
        return [fallbackItem];
    }
    return out;
}
function uniqueCleanStrings(value, maxItems) {
    const out = new Set();
    for (const entry of value) {
        const normalized = normalizeOptionalString(entry);
        if (!normalized) {
            continue;
        }
        out.add(normalized);
        if (out.size >= maxItems) {
            break;
        }
    }
    return Array.from(out);
}
function mergeUniqueStrings(...groups) {
    const out = new Set();
    for (const group of groups) {
        for (const entry of group) {
            const normalized = normalizeOptionalString(entry);
            if (normalized) {
                out.add(normalized);
            }
        }
    }
    return Array.from(out);
}
function applyMaxCharacters(value, maxCharacters) {
    const normalized = normalizeDraftInput(value);
    if (!maxCharacters || normalized.length <= maxCharacters) {
        return normalized;
    }
    const clipped = normalized.slice(0, Math.max(1, maxCharacters - 1)).trimEnd();
    return `${clipped}…`;
}
function normalizeDraftInput(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value
        .replace(/\r\n/g, "\n")
        .replace(/\u0000/g, "")
        .trim();
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
function extractAssistantContent(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        const textParts = content
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
        if (textParts.length > 0) {
            return textParts.join("\n");
        }
    }
    throw new Error("ML_AI_EMPTY_RESPONSE");
}
function parseJsonObject(rawContent) {
    const raw = typeof rawContent === "string" ? rawContent : "";
    const withoutFences = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const extracted = extractBalancedJsonObject(withoutFences) ?? extractBalancedJsonObject(raw) ?? withoutFences;
    const candidates = uniqueCleanStrings([withoutFences, extracted], 4);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // continue
        }
    }
    throw new Error("ML_AI_BAD_JSON");
}
function extractBalancedJsonObject(value) {
    const start = value.indexOf("{");
    if (start < 0) {
        return null;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const char = value[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{") {
            depth += 1;
        }
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return value.slice(start, index + 1);
            }
        }
    }
    return null;
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
