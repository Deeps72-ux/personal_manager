/**
 * In-memory LocalStore + SessionStore. Used by tests, and a living proof of
 * Liskov substitution: the same contract tests pass for this and for Dexie.
 */
import type { Change, Day, LogEntry, Placement, Task } from "@pm/shared";
import type { LocalStore, LocalTx, Session, SessionStore } from "../core/ports.ts";

interface Data {
  tasks: Map<string, Task>;
  placements: Map<string, Placement>;
  logs: Map<string, LogEntry>;
  outbox: Change[];
  cursor: number;
  purgedBefore: Day | null;
}

const empty = (): Data => ({
  tasks: new Map(),
  placements: new Map(),
  logs: new Map(),
  outbox: [],
  cursor: 0,
  purgedBefore: null,
});

const clone = (d: Data): Data => ({
  tasks: new Map(d.tasks),
  placements: new Map(d.placements),
  logs: new Map(d.logs),
  outbox: [...d.outbox],
  cursor: d.cursor,
  purgedBefore: d.purgedBefore,
});

const byDayThenId = (a: LogEntry, b: LogEntry) => (a.day === b.day ? (a.id < b.id ? -1 : 1) : a.day < b.day ? -1 : 1);

export class MemoryStore implements LocalStore {
  private data = empty();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  write<T>(fn: (tx: LocalTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = clone(this.data); // atomic: commit only if fn succeeds
      const result = await fn(txFor(draft));
      this.data = draft;
      this.emit();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async listTasks() {
    return [...this.data.tasks.values()];
  }
  async listPlacements() {
    return [...this.data.placements.values()];
  }
  async listLogsForDay(day: Day) {
    return [...this.data.logs.values()].filter((l) => l.day === day).sort(byDayThenId);
  }
  async listLogsBetween(from: Day, to: Day) {
    return [...this.data.logs.values()].filter((l) => l.day >= from && l.day <= to).sort(byDayThenId);
  }
  async listOutbox() {
    return [...this.data.outbox];
  }
  async removeFromOutbox(ids: readonly string[]) {
    const drop = new Set(ids);
    this.data = { ...this.data, outbox: this.data.outbox.filter((c) => !drop.has(c.changeId)) };
    this.emit();
  }
  async cursor() {
    return this.data.cursor;
  }
  async purgedBefore() {
    return this.data.purgedBefore;
  }
  async wipe() {
    this.data = empty();
    this.emit();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
}

function txFor(d: Data): LocalTx {
  return {
    getTask: async (id) => d.tasks.get(id),
    putTask: async (t) => void d.tasks.set(t.id, t),
    deleteTask: async (id) => void d.tasks.delete(id),
    getPlacement: async (id) => d.placements.get(id),
    putPlacement: async (p) => void d.placements.set(p.taskId, p),
    deletePlacement: async (id) => void d.placements.delete(id),
    listPlacements: async () => [...d.placements.values()],
    putLog: async (l) => void d.logs.set(l.id, l),
    deleteLog: async (id) => void d.logs.delete(id),
    deleteLogsBefore: async (day) => {
      for (const [id, l] of d.logs) if (l.day < day) d.logs.delete(id);
    },
    listLogsForDay: async (day) => [...d.logs.values()].filter((l) => l.day === day).sort(byDayThenId),
    enqueue: async (c) => void d.outbox.push(c),
    listOutbox: async () => [...d.outbox],
    setCursor: async (c) => void (d.cursor = c),
    getPurgedBefore: async () => d.purgedBefore,
    setPurgedBefore: async (day) => void (d.purgedBefore = day),
    clearSynced: async () => {
      d.tasks.clear();
      d.placements.clear();
      d.logs.clear();
    },
  };
}

export class MemorySessionStore implements SessionStore {
  private session: Session | null = null;
  private ownerId: string | null = null;
  async load() {
    return this.session;
  }
  async save(s: Session) {
    this.session = s;
    this.ownerId = s.user.id;
  }
  async clearToken() {
    this.session = null;
  }
  async owner() {
    return this.ownerId;
  }
  async clear() {
    this.session = null;
    this.ownerId = null;
  }
}
