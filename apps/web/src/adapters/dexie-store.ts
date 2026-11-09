/**
 * IndexedDB adapter (via Dexie). This is the device's offline copy:
 * it survives app restarts and works with no network at all.
 */
import { Dexie, type Table } from "dexie";
import type { Change, Day, LogEntry, Placement, Task } from "@pm/shared";
import type { LocalStore, LocalTx, Session, SessionStore } from "../core/ports.ts";

interface OutboxRow {
  seq?: number;
  changeId: string;
  change: Change;
}
interface MetaRow {
  key: string;
  value: unknown;
}

class Db extends Dexie {
  tasks!: Table<Task, string>;
  placements!: Table<Placement, string>;
  logs!: Table<LogEntry, string>;
  outbox!: Table<OutboxRow, number>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      tasks: "id",
      placements: "taskId",
      logs: "id, day",
      outbox: "++seq, changeId",
      meta: "key",
    });
  }
}

const SYNCED = ["tasks", "placements", "logs"] as const;
const TIMER_KEY = "timerStartedAt";

export class DexieStore implements LocalStore, SessionStore {
  private readonly db: Db;
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;

  constructor(name = "personal-manager") {
    this.db = new Db(name);
    // Other open tabs of the app learn about our writes, and vice versa.
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`${name}-changes`);
    if (this.channel) this.channel.onmessage = () => this.notifyLocal();
  }

  async write<T>(fn: (tx: LocalTx) => Promise<T>): Promise<T> {
    const db = this.db;
    const result = await db.transaction("rw", [db.tasks, db.placements, db.logs, db.outbox, db.meta], () =>
      fn(this.tx()),
    );
    this.emit();
    return result;
  }

  private tx(): LocalTx {
    const db = this.db;
    return {
      getTask: (id) => db.tasks.get(id),
      putTask: async (t) => void (await db.tasks.put(t)),
      deleteTask: (id) => db.tasks.delete(id),
      getPlacement: (id) => db.placements.get(id),
      putPlacement: async (p) => void (await db.placements.put(p)),
      deletePlacement: (id) => db.placements.delete(id),
      listPlacements: () => db.placements.toArray(),
      putLog: async (l) => void (await db.logs.put(l)),
      deleteLog: (id) => db.logs.delete(id),
      deleteLogsBefore: async (day) => void (await db.logs.where("day").below(day).delete()),
      listLogsForDay: (day) => db.logs.where("day").equals(day).sortBy("id"),
      enqueue: async (change) => void (await db.outbox.add({ changeId: change.changeId, change })),
      listOutbox: async () => (await db.outbox.orderBy("seq").toArray()).map((r) => r.change),
      setCursor: async (c) => void (await db.meta.put({ key: "cursor", value: c })),
      getPurgedBefore: async () => ((await db.meta.get("purgedBefore"))?.value as Day | null) ?? null,
      setPurgedBefore: async (day) => void (await db.meta.put({ key: "purgedBefore", value: day })),
      getTimerStart: async () => ((await db.meta.get(TIMER_KEY))?.value as number | undefined) ?? null,
      setTimerStart: async (ms) => void (await db.meta.put({ key: TIMER_KEY, value: ms })),
      clearSynced: async () => {
        await Promise.all(SYNCED.map((t) => db[t].clear()));
      },
    };
  }

  listTasks() {
    return this.db.tasks.toArray();
  }
  listPlacements() {
    return this.db.placements.toArray();
  }
  listLogsForDay(day: Day) {
    return this.db.logs.where("day").equals(day).sortBy("id");
  }
  async listLogsBetween(from: Day, to: Day) {
    const rows = await this.db.logs.where("day").between(from, to, true, true).toArray();
    return rows.sort((a, b) => (a.day === b.day ? (a.id < b.id ? -1 : 1) : a.day < b.day ? -1 : 1));
  }
  async listOutbox() {
    return (await this.db.outbox.orderBy("seq").toArray()).map((r) => r.change);
  }
  async removeFromOutbox(ids: readonly string[]) {
    if (ids.length === 0) return;
    await this.db.outbox.where("changeId").anyOf([...ids]).delete();
    this.emit();
  }
  async cursor() {
    return ((await this.db.meta.get("cursor"))?.value as number | undefined) ?? 0;
  }
  async purgedBefore() {
    return ((await this.db.meta.get("purgedBefore"))?.value as Day | null | undefined) ?? null;
  }
  async timerStart() {
    return ((await this.db.meta.get(TIMER_KEY))?.value as number | undefined) ?? null;
  }
  async wipe() {
    const db = this.db;
    await db.transaction("rw", [db.tasks, db.placements, db.logs, db.outbox, db.meta], async () => {
      await Promise.all([db.tasks.clear(), db.placements.clear(), db.logs.clear(), db.outbox.clear(), db.meta.clear()]);
    });
    this.emit();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyLocal() {
    for (const l of this.listeners) l();
  }

  private emit() {
    this.notifyLocal();
    this.channel?.postMessage("changed");
  }

  // ── SessionStore (kept in the same database, `meta` table) ──

  async load(): Promise<Session | null> {
    return ((await this.db.meta.get("session"))?.value as Session | undefined) ?? null;
  }
  async save(session: Session) {
    await this.db.meta.bulkPut([
      { key: "session", value: session },
      { key: "owner", value: session.user.id },
    ]);
  }
  async clearToken() {
    await this.db.meta.delete("session");
  }
  async owner() {
    return ((await this.db.meta.get("owner"))?.value as string | undefined) ?? null;
  }
  async clear() {
    await this.db.meta.bulkDelete(["session", "owner"]);
  }

  close() {
    this.channel?.close();
    this.db.close();
  }
}
