import { describe, expect, it } from "vitest";
import {
  ChangeSchema,
  LogEntrySchema,
  PullResponseSchema,
  PushRequestSchema,
  TaskPatchSchema,
  TaskSchema,
  uuidv7,
} from "../src/index.ts";

const id = () => uuidv7();

describe("TaskSchema", () => {
  it("accepts a minimal task", () => {
    const t = { id: id(), title: "Gym", description: null, dueDate: null };
    expect(TaskSchema.parse(t)).toEqual(t);
  });

  it("trims the title and rejects blank", () => {
    expect(TaskSchema.parse({ id: id(), title: "  Gym ", description: null, dueDate: null }).title).toBe("Gym");
    expect(TaskSchema.safeParse({ id: id(), title: "   ", description: null, dueDate: null }).success).toBe(false);
  });

  it("rejects unknown fields (e.g. a client trying to send userId)", () => {
    const r = TaskSchema.safeParse({ id: id(), title: "x", description: null, dueDate: null, userId: "u1" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-v7 id and impossible due dates", () => {
    expect(TaskSchema.safeParse({ id: "1", title: "x", description: null, dueDate: null }).success).toBe(false);
    expect(TaskSchema.safeParse({ id: id(), title: "x", description: null, dueDate: "2026-02-30" }).success).toBe(false);
  });
});

describe("LogEntrySchema", () => {
  const entry = { id: id(), day: "2026-11-05", seconds: 27, taskTitle: "Task7" };
  it("accepts a valid entry", () => expect(LogEntrySchema.parse(entry)).toEqual(entry));
  it.each([0, 86_401, 1.5, -1])("rejects seconds=%s", (seconds) => {
    expect(LogEntrySchema.safeParse({ ...entry, seconds }).success).toBe(false);
  });
  it("has no taskId: logs are independent of tasks", () => {
    expect(LogEntrySchema.safeParse({ ...entry, taskId: id() }).success).toBe(false);
  });
});

describe("TaskPatchSchema", () => {
  it("accepts a single-field patch and clearing a field", () => {
    expect(TaskPatchSchema.parse({ title: "Workout" })).toEqual({ title: "Workout" });
    expect(TaskPatchSchema.parse({ dueDate: null })).toEqual({ dueDate: null });
  });
  it("rejects an empty patch", () => {
    expect(TaskPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("ChangeSchema", () => {
  it("parses every op", () => {
    const task = { id: id(), title: "Gym", description: null, dueDate: null };
    const changes = [
      { changeId: id(), op: "createTask", task, rank: "a0" },
      { changeId: id(), op: "updateTask", taskId: task.id, patch: { title: "Workout" } },
      { changeId: id(), op: "moveTask", taskId: task.id, rank: "a0V" },
      { changeId: id(), op: "deleteTask", taskId: task.id },
      { changeId: id(), op: "createLog", entry: { id: id(), day: "2026-11-05", seconds: 27, taskTitle: "Gym" } },
      { changeId: id(), op: "deleteLog", logId: id() },
      { changeId: id(), op: "purgeLogsBefore", before: "2026-01-01" },
    ];
    for (const c of changes) expect(ChangeSchema.parse(c)).toEqual(c);
  });

  it("rejects unknown ops and bad ranks", () => {
    expect(ChangeSchema.safeParse({ changeId: id(), op: "dropTable" }).success).toBe(false);
    expect(ChangeSchema.safeParse({ changeId: id(), op: "moveTask", taskId: id(), rank: "!!" }).success).toBe(false);
  });

  it("push request must have 1..500 changes", () => {
    expect(PushRequestSchema.safeParse({ changes: [] }).success).toBe(false);
  });
});

describe("PullResponseSchema", () => {
  it("accepts an empty incremental page", () => {
    const r = {
      mode: "incremental",
      cursor: 42,
      hasMore: false,
      purgedBefore: null,
      upserts: { tasks: [], placements: [], logEntries: [] },
      deletes: { tasks: [], placements: [], logEntries: [] },
    };
    expect(PullResponseSchema.parse(r)).toEqual(r);
  });
});
