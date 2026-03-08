export class NonceCache {
  private readonly store = new Map<string, number>();

  constructor(private readonly ttlMs = 120_000) {}

  checkAndStore(scope: string, nonce: string, nowMs = Date.now()): boolean {
    this.purge(nowMs);
    const key = `${scope}:${nonce}`;
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, nowMs + this.ttlMs);
    return true;
  }

  purge(nowMs = Date.now()): void {
    for (const [key, expiresAt] of this.store.entries()) {
      if (expiresAt <= nowMs) this.store.delete(key);
    }
  }
}
