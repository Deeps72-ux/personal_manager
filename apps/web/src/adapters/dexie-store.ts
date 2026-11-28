/**
 * IndexedDB adapter (via Dexie). This is the device's offline copy:
 * it survives app restarts and works with no network at all.
 */
import { Dexie, type Table } from "dexie";
import type { Change, Day, Folder, HiddenActivity, LogEntry, Placement, PrioritySlot, PrioritySnapshot, Task } from "@pm/shared";
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
  folders!: Table<Folder, string>;
  logs!: Table<LogEntry, string>;
  history!: Table<PrioritySnapshot, string>;
  slots!: Table<PrioritySlot, string>;
  hidden!: Table<HiddenActivity, string>;
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
    this.version(2).stores({ history: "id, at" });
    this.version(3).stores({ folders: "id" });
    this.version(4).stores({ slots: "id, startMs" });
    this.version(5).stores({ hidden: "id" });
  }
}

const SYNCED = ["tasks", "placements", "folders", "logs", "history", "slots", "hidden"] as const;
const TIMER_KEY = "timerStartedAt";
const TIMER_PROVISIONAL_KEY = "timerProvisional";
const byAtThenId = (a: PrioritySnapshot, b: PrioritySnapshot) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
    const result = await db.transaction("rw", [db.tasks, db.placements, db.folders, db.logs, db.history, db.slots, db.hidden, db.outbox, db.meta], async () =>
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
      listTasks: () => db.tasks.toArray(),
      getPlacement: (id) => db.placements.get(id),
      putPlacement: async (p) => void (await db.placements.put(p)),
      deletePlacement: (id) => db.placements.delete(id),
      listPlacements: () => db.placements.toArray(),
      getFolder: (id) => db.folders.get(id),
      putFolder: async (f) => void (await db.folders.put(f)),
      deleteFolder: (id) => db.folders.delete(id),
      listFolders: () => db.folders.toArray(),
      putLog: async (l) => void (await db.logs.put(l)),
      deleteLog: (id) => db.logs.delete(id),
      deleteLogsBefore: async (day) => void (await db.logs.where("day").below(day).delete()),
      listLogsForDay: (day) => db.logs.where("day").equals(day).sortBy("id"),
      putSnapshot: async (s) => void (await db.history.put(s)),
      listHistory: async () => (await db.history.toArray()).sort(byAtThenId),
      getSlot: (id) => db.slots.get(id),
      putSlot: async (sl) => void (await db.slots.put(sl)),
      deleteSlot: (id) => db.slots.delete(id),
      listSlots: () => db.slots.orderBy("startMs").toArray(),
      putHidden: async (h) => void (await db.hidden.put(h)),
      deleteHidden: (id) => db.hidden.delete(id),
      listHidden: () => db.hidden.toArray(),
      enqueue: async (change) => void (await db.outbox.add({ changeId: change.changeId, change })),
      listOutbox: async () => (await db.outbox.orderBy("seq").toArray()).map((r) => r.change),
      setCursor: async (c) => void (await db.meta.put({ key: "cursor", value: c })),
      getPurgedBefore: async () => ((await db.meta.get("purgedBefore"))?.value as Day | null) ?? null,
      setPurgedBefore: async (day) => void (await db.meta.put({ key: "purgedBefore", value: day })),
      getTimerStart: async () => ((await db.meta.get(TIMER_KEY))?.value as number | undefined) ?? null,
      setTimerStart: async (ms, provisional = false) =>
        void (await db.meta.bulkPut([
          { key: TIMER_KEY, value: ms },
          { key: TIMER_PROVISIONAL_KEY, value: provisional },
        ])),
      isTimerProvisional: async () => (await db.meta.get(TIMER_PROVISIONAL_KEY))?.value === true,
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
  listFolders() {
    return this.db.folders.toArray();
  }
  listLogsForDay(day: Day) {
    return this.db.logs.where("day").equals(day).sortBy("id");
  }
  async listLogsBetween(from: Day, to: Day) {
    const rows = await this.db.logs.where("day").between(from, to, true, true).toArray();
    return rows.sort((a, b) => (a.day === b.day ? (a.id < b.id ? -1 : 1) : a.day < b.day ? -1 : 1));
  }
  async listHistory() {
    return (await this.db.history.toArray()).sort(byAtThenId);
  }
  listSlots() {
    return this.db.slots.orderBy("startMs").toArray();
  }
  listHidden() {
    return this.db.hidden.toArray();
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
    await db.transaction("rw", [db.tasks, db.placements, db.folders, db.logs, db.history, db.slots, db.hidden, db.outbox, db.meta], async () => {
      await Promise.all([
        db.tasks.clear(),
        db.placements.clear(),
        db.folders.clear(),
        db.logs.clear(),
        db.history.clear(),
        db.slots.clear(),
        db.hidden.clear(),
        db.outbox.clear(),
        db.meta.clear(),
      ]);
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
