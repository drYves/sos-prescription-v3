"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryGuard = void 0;
class MemoryGuard {
    maxMb;
    resumeMb;
    state = "OK";
    constructor(maxMb, resumeMb) {
        this.maxMb = maxMb;
        this.resumeMb = resumeMb;
        if (resumeMb >= maxMb) {
            throw new Error("resumeMb must be < maxMb (hysteresis required).");
        }
    }
    tick() {
        const rssMb = this.rssMb();
        if (this.state === "OK" && rssMb >= this.maxMb) {
            this.state = "DEGRADED";
        }
        else if (this.state === "DEGRADED" && rssMb <= this.resumeMb) {
            this.state = "OK";
        }
        return this.state;
    }
    getState() {
        return this.state;
    }
    canClaim() {
        return this.state === "OK";
    }
    rssMb() {
        return Math.round(process.memoryUsage().rss / 1024 / 1024);
    }
}
exports.MemoryGuard = MemoryGuard;
