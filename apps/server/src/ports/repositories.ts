/**
 * Persistence ports. Use cases depend on THESE interfaces, never on SQLite
 * (Dependency Inversion). Each interface covers one aggregate (Interface
 * Segregation), so a handler that only touches logs only sees LogRepository.
 *
 * ISOLATION RULE: every method that reads or writes user data takes `userId`
 * as its first argument. There is no way to call a repository "for all users".
 */
import type { Day, LogEntry, Placement, Task, TaskPatch } from "@pm/shared";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  purgedBefore: Day | null;
}

export interface UserRepository {
  findByUsername(username: string): Promise<UserRecord | null>;
  findById(userId: string): Promise<UserRecord | null>;
  /** Throws UsernameTakenError if the username exists. */
  insert(user: UserRecord): Promise<void>;
  setPurgedBefore(userId: string, day: Day): Promise<void>;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number; // unix ms
}

export interface SessionRepository {
  insert(session: SessionRecord): Promise<void>;
  /** Returns the session only if it exists and has not expired. */
  findValid(tokenHash: string, nowMs: number): Promise<SessionRecord | null>;
  setExpiry(tokenHash: string, expiresAt: number): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<number>;
}

export interface TaskRepository {
  get(userId: string, id: string): Promise<Task | null>;
  getMany(userId: string, ids: readonly string[]): Promise<Task[]>;
  listAll(userId: string): Promise<Task[]>;
  insert(userId: string, task: Task): Promise<void>;
  update(userId: string, id: string, patch: TaskPatch): Promise<void>;
  delete(userId: string, id: string): Promise<void>;
}

export interface PlacementRepository {
  get(userId: string, taskId: string): Promise<Placement | null>;
  getMany(userId: string, taskIds: readonly string[]): Promise<Placement[]>;
  listAll(userId: string): Promise<Placement[]>;
  insert(userId: string, placement: Placement): Promise<void>;
  setRank(userId: string, taskId: string, rank: string): Promise<void>;
  delete(userId: string, taskId: string): Promise<void>;
}

export interface LogRepository {
  get(userId: string, id: string): Promise<LogEntry | null>;
  getMany(userId: string, ids: readonly string[]): Promise<LogEntry[]>;
  listAll(userId: string): Promise<LogEntry[]>;
  insert(userId: string, entry: LogEntry): Promise<void>;
  delete(userId: string, id: string): Promise<void>;
  /** Hard-deletes logs with day < `before` and returns their ids. */
  deleteBefore(userId: string, before: Day): Promise<string[]>;
}

export type SyncedTable = "tasks" | "placements" | "log_entries";
export type ChangeOpKind = "upsert" | "delete";

export interface ChangeLogEntry {
  seq: number;
  table: SyncedTable;
  rowId: string;
  op: ChangeOpKind;
}

/** Server-only history of "row X changed / was deleted" (no content). */
export interface ChangeLogRepository {
  append(userId: string, table: SyncedTable, rowId: string, op: ChangeOpKind, nowMs: number): Promise<number>;
  listAfter(userId: string, cursor: number, limit: number): Promise<ChangeLogEntry[]>;
  /** True if the most recent retained entry for this row is a delete. */
  wasDeleted(userId: string, table: SyncedTable, rowId: string): Promise<boolean>;
  /** Highest seq ever issued (0 if none). */
  currentSeq(): Promise<number>;
  /** Every seq <= floor has been cleaned up; a cursor below it missed history. */
  floor(): Promise<number>;
  /** Deletes the oldest entries created before `cutoffMs`; returns how many. */
  deleteOlderThan(cutoffMs: number): Promise<number>;
}

/** Everything a use case may touch inside one transaction. */
export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  placements: PlacementRepository;
  logs: LogRepository;
  changeLog: ChangeLogRepository;
}
