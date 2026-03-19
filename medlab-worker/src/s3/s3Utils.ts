export function normalizeMetadata(meta?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    out[key] = String(v).slice(0, 256);
  }
  return out;
}
