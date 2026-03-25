"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildQrSvg = buildQrSvg;
exports.buildQrDataUri = buildQrDataUri;
exports.svgToDataUri = svgToDataUri;
// src/pdf/assets/qrSvg.ts
const qrcode_1 = __importDefault(require("qrcode"));
const DEFAULT_SIZE = 256;
const DEFAULT_MARGIN = 1;
const DEFAULT_DARK = "#0f172a";
const DEFAULT_LIGHT = "#ffffff";
async function buildQrSvg(text, options = {}) {
    const value = normalizeInput(text);
    if (value === "") {
        return "";
    }
    try {
        return await qrcode_1.default.toString(value, {
            type: "svg",
            width: clampInt(options.size, 64, 1024, DEFAULT_SIZE),
            margin: clampInt(options.margin, 0, 16, DEFAULT_MARGIN),
            errorCorrectionLevel: options.errorCorrectionLevel ?? "M",
            color: {
                dark: normalizeColor(options.darkColor, DEFAULT_DARK),
                light: normalizeColor(options.lightColor, DEFAULT_LIGHT),
            },
        });
    }
    catch (_err) {
        return "";
    }
}
async function buildQrDataUri(text, options = {}) {
    const svg = await buildQrSvg(text, options);
    return svg !== "" ? svgToDataUri(svg) : "";
}
function svgToDataUri(svg) {
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
function normalizeInput(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeColor(value, fallback) {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw !== "" ? raw : fallback;
}
function clampInt(value, min, max, fallback) {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    const safe = Math.trunc(Number(value));
    return Math.max(min, Math.min(max, safe));
}
