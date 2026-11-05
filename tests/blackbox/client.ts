/**
 * Test-side HTTP client + a simulated DEVICE.
 *
 * `Device` mimics what the real PWA will do (Phase C): keep a local copy,
 * queue changes in an outbox while "offline", then push → pull on sync.
 * Several Devices against one server let us test convergence.
 */
import {
  compareRanked,
  rankAt,
  rankForTop,
  uuidv7,
  type AuthResponse,
  type Change,
  type LogEntry,
  type NewChange,
  type Placement,
  type PullResponse,
  type PushResponse,
  type Task,
  type TaskPatch,
} from "@pm/shared";

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export class Api {
  readonly baseUrl: string;
  token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async request<T = any>(method: string, path: string, body?: unknown, rawBody?: string): Promise<HttpResult<T>> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? null : JSON.stringify(body)),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async signUp(username: string, password = "password123") {
    const r = await this.request<AuthResponse>("POST", "/api/auth/signup", { username, password });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    return r.body;
  }

  async signIn(username: string, password = "password123") {
    const r = await this.request<AuthResponse>("POST", "/api/auth/signin", { username, password });
    if (r.status !== 200) throw new Error(`signin failed: ${JSON.stringify(r.body)}`);
    this.token = r.body.token;
    return r.body;
  }
}

let userCounter = 0;
export const uniqueUsername = (prefix = "user") => `${prefix}${Date.now().toString(36)}${userCounter++}`;

export class Device {
  readonly api: Api;
  readonly name: string;
  tasks = new Map<string, Task>();
  placements = new Map<string, Placement>();
  logs = new Map<string, LogEntry>();
  outbox: Change[] = [];
  cursor = 0;
  purgedBefore: string | null = null;
  lastPush: PushResponse | null = null;

  constructor(api: Api, name: string) {
    this.api = api;
    this.name = name;
  }

  // ── local actions (work offline; just queue) ──

  private queue(c: NewChange) {
    this.outbox.push({ changeId: uuidv7(), ...c });
  }

  createTask(title: string, extra: Partial<Pick<Task, "description" | "dueDate">> = {}): Task {
    const task: Task = { id: uuidv7(), title, description: null, dueDate: null, ...extra };
    const rank = rankForTop(this.sortedPlacements().map((p) => p.rank));
    this.tasks.set(task.id, task);
    this.placements.set(task.id, { taskId: task.id, rank });
    this.queue({ op: "createTask", task, rank });
    return task;
  }

  updateTask(taskId: string, patch: TaskPatch) {
    const t = this.tasks.get(taskId)!;
    this.tasks.set(taskId, { ...t, ...(patch as Partial<Task>) });
    this.queue({ op: "updateTask", taskId, patch });
  }

  moveTask(taskId: string, toIndex: number) {
    const others = this.sortedPlacements().filter((p) => p.taskId !== taskId);
    const rank = rankAt(others.map((p) => p.rank), toIndex);
    this.placements.set(taskId, { taskId, rank });
    this.queue({ op: "moveTask", taskId, rank });
  }

  deleteTask(taskId: string) {
    this.tasks.delete(taskId);
    this.placements.delete(taskId);
    this.queue({ op: "deleteTask", taskId });
  }

  createLog(day: string, seconds: number, taskTitle: string): LogEntry {
    const entry: LogEntry = { id: uuidv7(), day, seconds, taskTitle };
    this.logs.set(entry.id, entry);
    this.queue({ op: "createLog", entry });
    return entry;
  }

  deleteLog(logId: string) {
    this.logs.delete(logId);
    this.queue({ op: "deleteLog", logId });
  }

  purgeLogsBefore(before: string) {
    for (const [id, l] of this.logs) if (l.day < before) this.logs.delete(id);
    this.queue({ op: "purgeLogsBefore", before });
  }

  // ── sync: push outbox, then pull until caught up ──

  async sync() {
    if (this.outbox.length > 0) {
      const sent = this.outbox;
      const r = await this.api.request<PushResponse>("POST", "/api/sync/push", { changes: sent });
      if (r.status !== 200) throw new Error(`${this.name} push failed: ${r.status} ${JSON.stringify(r.body)}`);
      this.lastPush = r.body;
      const done = new Set(r.body.results.map((x) => x.changeId));
      this.outbox = this.outbox.filter((c) => !done.has(c.changeId));
      // A log refused by the purge guard must disappear locally too.
      for (const res of r.body.results) {
        if (res.status === "ignored" && res.reason === "purged") {
          const c = sent.find((x) => x.changeId === res.changeId);
          if (c?.op === "createLog") this.logs.delete(c.entry.id);
        }
      }
    }
    for (;;) {
      const r = await this.api.request<PullResponse>("GET", `/api/sync/pull?cursor=${this.cursor}`);
      if (r.status !== 200) throw new Error(`${this.name} pull failed: ${r.status} ${JSON.stringify(r.body)}`);
      this.apply(r.body);
      if (!r.body.hasMore) break;
    }
  }

  private apply(p: PullResponse) {
    if (p.mode === "snapshot") {
      this.tasks.clear();
      this.placements.clear();
      this.logs.clear();
    }
    for (const id of p.deletes.tasks) this.tasks.delete(id);
    for (const id of p.deletes.placements) this.placements.delete(id);
    for (const id of p.deletes.logEntries) this.logs.delete(id);
    for (const t of p.upserts.tasks) this.tasks.set(t.id, t);
    for (const pl of p.upserts.placements) this.placements.set(pl.taskId, pl);
    for (const l of p.upserts.logEntries) this.logs.set(l.id, l);
    this.cursor = p.cursor;
    this.purgedBefore = p.purgedBefore;
  }

  // ── views ──

  sortedPlacements(): Placement[] {
    return [...this.placements.values()]
      .map((p) => ({ ...p, id: p.taskId }))
      .sort(compareRanked)
      .map(({ taskId, rank }) => ({ taskId, rank }));
  }

  /** PRIORITY screen, top to bottom. */
  priorityTitles(): string[] {
    return this.sortedPlacements().map((p) => this.tasks.get(p.taskId)?.title ?? "?");
  }

  dayTitles(day: string): string[] {
    return [...this.logs.values()].filter((l) => l.day === day).map((l) => `${l.seconds}s ${l.taskTitle}`).sort();
  }

  /** Everything synced, normalized for equality checks between devices. */
  state() {
    const byId = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
    return { tasks: byId(this.tasks), placements: byId(this.placements), logs: byId(this.logs) };
  }
}

/** One user signed in on several devices. */
export async function userWithDevices(baseUrl: string, ...names: string[]) {
  const username = uniqueUsername();
  const first = new Api(baseUrl);
  await first.signUp(username);
  const devices = [new Device(first, names[0] ?? "d0")];
  for (const name of names.slice(1)) {
    const api = new Api(baseUrl);
    await api.signIn(username);
    devices.push(new Device(api, name));
  }
  for (const d of devices) await d.sync();
  return devices;
}
