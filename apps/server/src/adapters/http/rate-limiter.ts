import type { Clock } from "../../ports/services.ts";

/**
 * Fixed-window limiter: at most `max` hits per key per `windowMs`.
 * Used to slow down password guessing on sign-in / sign-up.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  private readonly opts: { max: number; windowMs: number; clock: Clock };

  constructor(opts: { max: number; windowMs: number; clock: Clock }) {
    this.opts = opts;
  }

  /** Records a hit; returns false if the key is over its limit. */
  hit(key: string): boolean {
    const now = this.opts.clock.nowMs();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.opts.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.opts.max;
  }

  private prune(now: number) {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) if (now - w.start >= this.opts.windowMs) this.windows.delete(k);
  }
}
