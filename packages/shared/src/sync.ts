/**
 * The sync protocol between a device and the server (design Step 4).
 *
 *   device ──POST /sync/push { changes }──► server   (outbox → server)
 *   device ──GET  /sync/pull?cursor=N────► server   (what changed after N?)
 *   server ──SSE  /sync/events ──────────► device   ("something changed")
 *
 * Every change is intent-based (one per use case) and safe to resend:
 * creates use client UUIDs, patches set values, deletes are deletes.
 */
import { z } from "zod";
import {
  DaySchema,
  IdSchema,
  LogEntrySchema,
  PlacementSchema,
  RankSchema,
  TaskPatchSchema,
  TaskSchema,
} from "./entities.ts";

export const SYNC_LIMITS = {
  /** Max changes in one push request. */
  maxPushChanges: 500,
  /** Max change_log rows returned by one pull page. */
  maxPullChanges: 1000,
  /** change_log rows older than this are cleaned up on the server. */
  changeLogRetentionDays: 30,
} as const;

// ───────────── outbox changes (device → server) ─────────────

const base = { changeId: IdSchema };

export const ChangeSchema = z.discriminatedUnion("op", [
  /** New task + its placement (at the top), created together. */
  z.strictObject({ ...base, op: z.literal("createTask"), task: TaskSchema, rank: RankSchema }),
  /** Field-level patch: only changed fields travel, so edits merge. */
  z.strictObject({ ...base, op: z.literal("updateTask"), taskId: IdSchema, patch: TaskPatchSchema }),
  /** Hard delete of task + placement. Logs are untouched. */
  z.strictObject({ ...base, op: z.literal("deleteTask"), taskId: IdSchema }),
  /** Drag-and-drop in PRIORITY: only this card's rank changes. */
  z.strictObject({ ...base, op: z.literal("moveTask"), taskId: IdSchema, rank: RankSchema }),
  z.strictObject({ ...base, op: z.literal("createLog"), entry: LogEntrySchema }),
  z.strictObject({ ...base, op: z.literal("deleteLog"), logId: IdSchema }),
  /** Hard delete every log with day < `before`; also arms the purge guard. */
  z.strictObject({ ...base, op: z.literal("purgeLogsBefore"), before: DaySchema }),
]);
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeOp = Change["op"];
/** A change before it gets its changeId (distributes over the union). */
export type NewChange = Change extends infer C ? (C extends Change ? Omit<C, "changeId"> : never) : never;

export const PushRequestSchema = z.strictObject({
  changes: z.array(ChangeSchema).min(1).max(SYNC_LIMITS.maxPushChanges),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/**
 * applied: change took effect.
 * ignored: change was valid but had no effect, and the device should drop it:
 *   - "deleted":   target task was deleted elsewhere (delete wins over edit/move)
 *   - "purged":    log day is before the purge date (purge guard)
 *   - "notFound":  nothing to delete/update (already gone)
 */
export const IgnoredReasonSchema = z.enum(["deleted", "purged", "notFound"]);
export type IgnoredReason = z.infer<typeof IgnoredReasonSchema>;

export const ChangeResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ changeId: IdSchema, status: z.literal("applied") }),
  z.strictObject({ changeId: IdSchema, status: z.literal("ignored"), reason: IgnoredReasonSchema }),
]);
export type ChangeResult = z.infer<typeof ChangeResultSchema>;

export const PushResponseSchema = z.strictObject({
  results: z.array(ChangeResultSchema),
});
export type PushResponse = z.infer<typeof PushResponseSchema>;

// ───────────── pull (server → device) ─────────────

const Cursor = z.int().min(0);

/**
 * incremental: apply `upserts` and `deletes` on top of local data.
 * snapshot:    the device's cursor is older than the retained change_log
 *              (offline > 30 days) or 0 (first sync): REPLACE all local
 *              synced data with `upserts` (deletes are empty).
 * hasMore:     pull again with the new cursor to get the next page.
 */
export const PullResponseSchema = z.strictObject({
  mode: z.enum(["incremental", "snapshot"]),
  cursor: Cursor,
  hasMore: z.boolean(),
  purgedBefore: DaySchema.nullable(),
  upserts: z.strictObject({
    tasks: z.array(TaskSchema),
    placements: z.array(PlacementSchema),
    logEntries: z.array(LogEntrySchema),
  }),
  deletes: z.strictObject({
    tasks: z.array(IdSchema),
    placements: z.array(IdSchema), // by taskId
    logEntries: z.array(IdSchema),
  }),
});
export type PullResponse = z.infer<typeof PullResponseSchema>;

// ───────────── real-time poke (server → device, SSE) ─────────────

export const SyncEventSchema = z.strictObject({
  type: z.literal("changed"),
  cursor: Cursor,
});
export type SyncEvent = z.infer<typeof SyncEventSchema>;
