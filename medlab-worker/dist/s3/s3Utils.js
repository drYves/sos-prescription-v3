"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMetadata = normalizeMetadata;
function normalizeMetadata(meta) {
    const out = {};
    for (const [k, v] of Object.entries(meta ?? {})) {
        const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        out[key] = String(v).slice(0, 256);
    }
    return out;
}
