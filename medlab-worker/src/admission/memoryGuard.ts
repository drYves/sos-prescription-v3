const MB = 1024 * 1024;

export class MemoryGuard {
  private paused = false;

  constructor(private readonly highWatermarkMb = 512, private readonly resumeWatermarkMb = 450) {}

  canRun(): boolean {
    const rssMb = process.memoryUsage().rss / MB;
    if (!this.paused && rssMb >= this.highWatermarkMb) {
      this.paused = true;
    } else if (this.paused && rssMb <= this.resumeWatermarkMb) {
      this.paused = false;
    }

    return !this.paused;
  }
}
