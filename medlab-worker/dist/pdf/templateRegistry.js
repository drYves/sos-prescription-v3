"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateRegistry = void 0;
exports.normalizeTemplateVariant = normalizeTemplateVariant;
// src/pdf/templateRegistry.ts
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const TEMPLATE_FILES = {
    standard: "rx-ordonnance-mpdf.html",
    modern: "rx-ordonnance-modern.html",
    minimal: "rx-ordonnance-minimal.html",
};
class TemplateRegistry {
    baseDirOverride;
    cache = new Map();
    constructor(cfg = {}) {
        this.baseDirOverride = cfg.baseDir;
    }
    async getTemplate(variant) {
        const normalized = normalizeTemplateVariant(variant);
        const cached = this.cache.get(normalized);
        if (cached) {
            return cached;
        }
        const baseDir = await this.resolveTemplateDir();
        const fileName = TEMPLATE_FILES[normalized];
        const absolutePath = node_path_1.default.join(baseDir, fileName);
        const html = await promises_1.default.readFile(absolutePath, "utf8");
        if (html.trim() === "") {
            throw new Error(`Template is empty: ${absolutePath}`);
        }
        const record = {
            variant: normalized,
            fileName,
            templateName: fileName,
            absolutePath,
            html,
        };
        this.cache.set(normalized, record);
        return record;
    }
    clearCache() {
        this.cache.clear();
    }
    async resolveTemplateDir() {
        const candidates = [
            this.baseDirOverride,
            process.env.ML_PDF_TEMPLATE_DIR,
            node_path_1.default.resolve(process.cwd(), "templates"),
            node_path_1.default.resolve(__dirname, "../../templates"),
            node_path_1.default.resolve(__dirname, "../templates"),
        ].filter((value) => typeof value === "string" && value.trim() !== "");
        for (const candidate of candidates) {
            try {
                const stat = await promises_1.default.stat(candidate);
                if (stat.isDirectory()) {
                    return candidate;
                }
            }
            catch (_err) {
                // noop
            }
        }
        throw new Error("PDF template directory not found. Set ML_PDF_TEMPLATE_DIR or provide templates/ at repo root.");
    }
}
exports.TemplateRegistry = TemplateRegistry;
function normalizeTemplateVariant(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (raw === "standard"
        || raw === "default"
        || raw === "mpdf"
        || raw === TEMPLATE_FILES.standard) {
        return "standard";
    }
    if (raw === "minimal" || raw === TEMPLATE_FILES.minimal) {
        return "minimal";
    }
    return "modern";
}
