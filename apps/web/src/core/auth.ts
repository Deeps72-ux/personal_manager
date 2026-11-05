import { CredentialsSchema, type User } from "@pm/shared";
import { NetworkError, RemoteError, ValidationError } from "./errors.ts";
import type { LocalStore, RemoteApi, Session, SessionStore } from "./ports.ts";

/** Holds the current session in memory so adapters can read the token synchronously. */
export class SessionHolder {
  current: Session | null = null;
  private readonly listeners = new Set<(s: Session | null) => void>();

  set(session: Session | null) {
    this.current = session;
    for (const l of this.listeners) l(session);
  }

  subscribe(listener: (s: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const FRIENDLY: Partial<Record<string, string>> = {
  invalid_credentials: "Wrong username or password",
  username_taken: "That username is already taken",
  signup_disabled: "Sign-up is turned off on this server",
  rate_limited: "Too many attempts. Wait a minute and try again",
};

interface AuthDeps {
  api: RemoteApi;
  sessions: SessionStore;
  store: LocalStore;
  holder: SessionHolder;
}

export class AuthService {
  private readonly deps: AuthDeps;
  constructor(deps: AuthDeps) {
    this.deps = deps;
  }

  /** Restore the saved session at startup: works fully offline. */
  async restore(): Promise<User | null> {
    const s = await this.deps.sessions.load();
    this.deps.holder.set(s);
    return s?.user ?? null;
  }

  signUp(username: string, password: string) {
    return this.enter("signUp", username, password);
  }

  signIn(username: string, password: string) {
    return this.enter("signIn", username, password);
  }

  /**
   * Revokes the token (best effort: works offline too) and wipes this
   * device's copy. Unsynced changes are lost, so the UI warns first.
   */
  async signOut(): Promise<void> {
    try {
      await this.deps.api.signOut();
    } catch {
      // offline or already expired: still sign out locally
    }
    await this.deps.sessions.clear();
    await this.deps.store.wipe();
    this.deps.holder.set(null);
  }

  /** Session rejected by the server: keep local data + outbox until re-sign-in. */
  async expire(): Promise<void> {
    await this.deps.sessions.clearToken();
    this.deps.holder.set(null);
  }

  private async enter(kind: "signUp" | "signIn", username: string, password: string): Promise<User> {
    const parsed = CredentialsSchema.safeParse({ username, password });
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid username or password");
    let res;
    try {
      res = await this.deps.api[kind](parsed.data);
    } catch (err) {
      if (err instanceof RemoteError) throw new ValidationError(FRIENDLY[err.code] ?? err.message);
      if (err instanceof NetworkError)
        throw new ValidationError("Can't reach the server. Is your Mac awake and Tailscale connected?");
      throw err;
    }
    // A different account on this device: never mix two users' data.
    const owner = await this.deps.sessions.owner();
    if (owner && owner !== res.user.id) await this.deps.store.wipe();

    const session = { token: res.token, user: res.user };
    await this.deps.sessions.save(session);
    this.deps.holder.set(session);
    return res.user;
  }
}
