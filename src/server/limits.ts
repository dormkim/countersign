// Per-IP guards for a public demo: how fast one address may call the API and
// how many fresh sessions it may open (so nobody can evict other visitors).
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear(); // crude memory bound
    return true;
  }
}

/** Client address; behind Render's proxy the first X-Forwarded-For entry. */
export function clientIp(headers: Record<string, string | string[] | undefined>, socketIp: string | undefined): string {
  const fwd = headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || socketIp || "unknown";
}
