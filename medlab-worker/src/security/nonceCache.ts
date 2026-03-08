export class NonceCache {
  private readonly map = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  checkAndStore(nonce: string, nowMs: number): boolean {
    this.gc(nowMs);

    const existing = this.map.get(nonce);
    if (existing && existing > nowMs) return false;

    this.map.set(nonce, nowMs + this.ttlMs);
    return true;
  }

  private gc(nowMs: number): void {
    let deletions = 0;
    for (const [nonce, exp] of this.map) {
      if (exp <= nowMs) {
        this.map.delete(nonce);
        deletions++;
        if (deletions >= 1000) break;
      }
    }
  }
}
