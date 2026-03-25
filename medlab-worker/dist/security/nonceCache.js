"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NonceCache = void 0;
class NonceCache {
    ttlMs;
    map = new Map();
    constructor(ttlMs) {
        this.ttlMs = ttlMs;
    }
    checkAndStore(nonce, nowMs) {
        this.gc(nowMs);
        const existing = this.map.get(nonce);
        if (existing && existing > nowMs)
            return false;
        this.map.set(nonce, nowMs + this.ttlMs);
        return true;
    }
    gc(nowMs) {
        let deletions = 0;
        for (const [nonce, exp] of this.map) {
            if (exp <= nowMs) {
                this.map.delete(nonce);
                deletions++;
                if (deletions >= 1000)
                    break;
            }
        }
    }
}
exports.NonceCache = NonceCache;
