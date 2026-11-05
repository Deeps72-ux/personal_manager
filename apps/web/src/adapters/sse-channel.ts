/**
 * SSE over fetch (not EventSource): EventSource cannot send the
 * `Authorization` header, and putting tokens in URLs leaks them into logs.
 *
 * Reconnects with exponential backoff (1s → 30s). Stops on 401.
 */
import { SyncEventSchema } from "@pm/shared";
import type { RealtimeChannel, RealtimeStatus } from "../core/ports.ts";

export interface SseOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export class SseChannel implements RealtimeChannel {
  private readonly opts: SseOptions;
  constructor(opts: SseOptions) {
    this.opts = opts;
  }

  connect(handlers: { onChanged(cursor: number): void; onStatus?(s: RealtimeStatus): void }): () => void {
    let closed = false;
    let ctrl: AbortController | null = null;
    let backoff = this.opts.minBackoffMs ?? 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const status = (s: RealtimeStatus) => handlers.onStatus?.(s);

    const loop = async () => {
      while (!closed) {
        const token = this.opts.getToken();
        if (!token) return status("unauthorized");
        ctrl = new AbortController();
        status("connecting");
        try {
          const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/api/sync/events`, {
            headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
            signal: ctrl.signal,
          });
          if (res.status === 401) return status("unauthorized");
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          status("open");
          backoff = this.opts.minBackoffMs ?? 1000;
          await readEvents(res.body, (data) => {
            const ev = SyncEventSchema.safeParse(safeJson(data));
            if (ev.success) handlers.onChanged(ev.data.cursor);
          });
        } catch {
          // network drop or abort: fall through to retry
        }
        if (closed) return;
        status("closed");
        await new Promise<void>((r) => (retryTimer = setTimeout(r, backoff)));
        backoff = Math.min(backoff * 2, this.opts.maxBackoffMs ?? 30_000);
      }
    };
    void loop();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ctrl?.abort();
      status("closed");
    };
  }
}

/** Minimal SSE parser: calls `onData` with each event's `data:` payload; ignores `:` comments. */
async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onData(data);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
