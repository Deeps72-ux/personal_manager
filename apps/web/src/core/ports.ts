/**
 * Client ports. The core (use cases + SyncEngine) depends only on these;
 * React, IndexedDB, fetch and SSE are adapters plugged in by main.tsx.
 */
import type {
  AuthResponse,
  Change,
  Credentials,
  Day,
  LogEntry,
  Placement,
  PullResponse,
  PushResponse,
  Task,
  User,
} from "@pm/shared";

// ───────────── local database (offline copy + outbox) ─────────────

/** Operations allowed inside one atomic local transaction. */
export interface LocalTx {
  getTask(id: string): Promise<Task | undefined>;
  putTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;

  getPlacement(taskId: string): Promise<Placement | undefined>;
  putPlacement(p: Placement): Promise<void>;
  deletePlacement(taskId: string): Promise<void>;
  listPlacements(): Promise<Placement[]>;

  putLog(entry: LogEntry): Promise<void>;
  deleteLog(id: string): Promise<void>;
  deleteLogsBefore(day: Day): Promise<void>;
  listLogsForDay(day: Day): Promise<LogEntry[]>;

  /** Append to the outbox (changes not yet accepted by the server). */
  enqueue(change: Change): Promise<void>;
  listOutbox(): Promise<Change[]>;

  setCursor(cursor: number): Promise<void>;
  getPurgedBefore(): Promise<Day | null>;
  setPurgedBefore(day: Day | null): Promise<void>;
  /** Remove all synced rows (tasks, placements, logs). Outbox is kept. */
  clearSynced(): Promise<void>;
}

export interface LocalStore {
  /** Run `fn` atomically; listeners are notified after it commits. */
  write<T>(fn: (tx: LocalTx) => Promise<T>): Promise<T>;

  listTasks(): Promise<Task[]>;
  listPlacements(): Promise<Placement[]>;
  listLogsForDay(day: Day): Promise<LogEntry[]>;
  /** Inclusive range, sorted by day. */
  listLogsBetween(from: Day, to: Day): Promise<LogEntry[]>;

  listOutbox(): Promise<Change[]>;
  removeFromOutbox(changeIds: readonly string[]): Promise<void>;
  cursor(): Promise<number>;
  purgedBefore(): Promise<Day | null>;

  /** Delete everything (used on sign-out / switching user). */
  wipe(): Promise<void>;

  /** Called after every committed write (from this tab or another tab). */
  subscribe(listener: () => void): () => void;
}

export interface Session {
  token: string;
  user: User;
}

export interface SessionStore {
  load(): Promise<Session | null>;
  /** Saves the session and records its user as the owner of local data. */
  save(session: Session): Promise<void>;
  /** Forget the token (expired) but remember whose data is on this device. */
  clearToken(): Promise<void>;
  /** User id that owns the local data, even after the token expired. */
  owner(): Promise<string | null>;
  /** Forget everything (sign-out). */
  clear(): Promise<void>;
}

// ───────────── server ─────────────

export interface RemoteApi {
  signUp(credentials: Credentials): Promise<AuthResponse>;
  signIn(credentials: Credentials): Promise<AuthResponse>;
  signOut(): Promise<void>;
  push(changes: readonly Change[]): Promise<PushResponse>;
  pull(cursor: number): Promise<PullResponse>;
}

export type RealtimeStatus = "connecting" | "open" | "closed" | "unauthorized";

/** Live "something changed" signal (SSE). Returns a disconnect function. */
export interface RealtimeChannel {
  connect(handlers: { onChanged(cursor: number): void; onStatus?(status: RealtimeStatus): void }): () => void;
}

// ───────────── misc ─────────────

/** Lets use cases say "there is something new to sync" without knowing the SyncEngine. */
export interface SyncTrigger {
  requestSync(): void;
}

export interface SpreadsheetWriter {
  writeLog(entries: readonly LogEntry[]): Promise<Blob>;
}

export interface FileSaver {
  save(blob: Blob, fileName: string): void;
}
