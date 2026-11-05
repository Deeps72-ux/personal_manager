import type { ChangeNotifier } from "../../ports/services.ts";

export type ChangeListener = (cursor: number) => void;

/**
 * In-memory pub/sub: use cases call notify(); each open SSE connection
 * subscribes for its user. Single server process, so memory is enough.
 * A multi-server setup would swap this for Redis pub/sub (same port).
 */
export class ChangeHub implements ChangeNotifier {
  private readonly listeners = new Map<string, Set<ChangeListener>>();

  subscribe(userId: string, listener: ChangeListener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  notify(userId: string, cursor: number): void {
    for (const listener of this.listeners.get(userId) ?? []) listener(cursor);
  }

  connectionCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}
