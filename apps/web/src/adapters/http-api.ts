import {
  AuthResponseSchema,
  ErrorResponseSchema,
  PullResponseSchema,
  PushResponseSchema,
  type Change,
  type Credentials,
} from "@pm/shared";
import type { z } from "zod";
import { AuthExpiredError, NetworkError, RemoteError } from "../core/errors.ts";
import type { RemoteApi } from "../core/ports.ts";

export interface HttpApiOptions {
  /** "" in the browser (same origin); a full URL in tests. */
  baseUrl: string;
  getToken: () => string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** RemoteApi over HTTP + JSON. Every response is validated against the shared schemas. */
export class HttpRemoteApi implements RemoteApi {
  private readonly opts: HttpApiOptions;
  constructor(opts: HttpApiOptions) {
    this.opts = opts;
  }

  signUp(c: Credentials) {
    return this.call("POST", "/api/auth/signup", AuthResponseSchema, c, false);
  }
  signIn(c: Credentials) {
    return this.call("POST", "/api/auth/signin", AuthResponseSchema, c, false);
  }
  async signOut() {
    await this.call("POST", "/api/auth/signout", null, undefined, true);
  }
  push(changes: readonly Change[]) {
    return this.call("POST", "/api/sync/push", PushResponseSchema, { changes }, true);
  }
  pull(cursor: number) {
    return this.call("GET", `/api/sync/pull?cursor=${cursor}`, PullResponseSchema, undefined, true);
  }

  private async call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T> | null,
    body: unknown,
    authed: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authed) {
      const token = this.opts.getToken();
      if (!token) throw new AuthExpiredError();
      headers.authorization = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : "network error");
    }

    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const parsed = ErrorResponseSchema.safeParse(json);
      if (res.status === 401 && authed) throw new AuthExpiredError();
      // A proxy error page (e.g. 502 while the Mac sleeps) counts as offline.
      if (!parsed.success) throw new NetworkError(`HTTP ${res.status}`);
      throw new RemoteError(parsed.data.error, parsed.data.message, res.status);
    }
    return (schema ? schema.parse(json) : undefined) as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
