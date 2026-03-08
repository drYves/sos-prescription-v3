export type AdmissionState = "OK" | "DEGRADED";

export class MemoryGuard {
  private state: AdmissionState = "OK";

  constructor(
    private readonly maxMb: number,
    private readonly resumeMb: number,
  ) {
    if (resumeMb >= maxMb) {
      throw new Error("resumeMb must be < maxMb (hysteresis required).");
    }
  }

  tick(): AdmissionState {
    const rssMb = this.rssMb();

    if (this.state === "OK" && rssMb >= this.maxMb) {
      this.state = "DEGRADED";
    } else if (this.state === "DEGRADED" && rssMb <= this.resumeMb) {
      this.state = "OK";
    }

    return this.state;
  }

  getState(): AdmissionState {
    return this.state;
  }

  canClaim(): boolean {
    return this.state === "OK";
  }

  rssMb(): number {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  }
}
