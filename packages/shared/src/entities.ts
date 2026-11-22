/**
 * The 3 synced record types, as devices and the server exchange them.
 *
 * `userId` is deliberately ABSENT: the server always takes the user from the
 * login token, never from the payload, so a device cannot even express
 * "write into someone else's data".
 *
 * Optional fields are `null` (not missing) so JSON round-trips are explicit.
 */
import { z } from "zod";
import { DAY_SECONDS, isValidDay } from "./day.ts";
import { isUuidV7 } from "./ids.ts";
import { isValidRank } from "./rank.ts";

export const LIMITS = {
  titleMax: 200,
  descriptionMax: 5000,
} as const;

export const IdSchema = z.string().refine(isUuidV7, "must be a UUIDv7");
export const DaySchema = z.string().refine(isValidDay, "must be a real date YYYY-MM-DD");
export const RankSchema = z.string().refine(isValidRank, "must be a fractional-index key");

const Title = z.string().trim().min(1, "title is required").max(LIMITS.titleMax);
const Description = z.string().max(LIMITS.descriptionMax).nullable();

export const TaskSchema = z.strictObject({
  id: IdSchema,
  title: Title,
  description: Description,
  dueDate: DaySchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

const EpochMs = z.int().min(0).max(2 ** 48 - 1);

/**
 * Where a task sits in the PRIORITY list (separate from Task: SRP).
 * `queuedAt`: when the task was dropped into the WAITING QUEUE (epoch ms).
 * A queued task leaves the visible priority list but keeps its rank. The
 * queue is never part of the scoring order. Missing/null = not queued.
 */
export const PlacementSchema = z.strictObject({
  taskId: IdSchema,
  rank: RankSchema,
  queuedAt: EpochMs.nullish(),
});
export type Placement = z.infer<typeof PlacementSchema>;

/** FOCUS / DEVIATION in percent. Missing or null = not scored (manual or older logs). */
const Percent = z.number().min(0).max(100).nullish();

/** Who made a log: the TIMER (✓) or a manual entry in the LOG calendar. */
export const LogSourceSchema = z.enum(["timer", "manual"]);
export type LogSource = z.infer<typeof LogSourceSchema>;

/**
 * One LOG row. Holds a COPY of the task title, not a task id: deleting or
 * renaming a task never touches past logs.
 *
 * `startMs` + `seconds` place the log on the clock: it covers
 * [startMs, startMs + seconds·1000). Logs from older versions have no
 * `startMs` (and no `source`).
 *
 * `focus` / `deviation` are the scores older versions stored on TIMER ✓.
 * New logs leave them null: deviation is worked out from the priority
 * history, focus per clock hour.
 */
export const LogEntrySchema = z.strictObject({
  id: IdSchema,
  day: DaySchema,
  seconds: z.int().min(1).max(DAY_SECONDS),
  taskTitle: Title,
  focus: Percent,
  deviation: Percent,
  startMs: EpochMs.nullish(),
  source: LogSourceSchema.nullish(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

/** Field-level patch for a task: only the fields that changed. */
export const TaskPatchSchema = z
  .strictObject({
    title: Title.optional(),
    description: Description.optional(),
    dueDate: DaySchema.nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "patch must change at least one field");
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/**
 * PRIORITY HISTORY: the scoring order (titles, best first) from `at` until
 * the next snapshot. Append-only, synced, never edited: a log is scored
 * against the order(s) in force while it ran.
 *
 * `confirmed`: true when the user pressed the confirm icon (the visible list
 * only, never the queue). Missing/null = a LEGACY snapshot that older
 * versions took on every change; those never count (see `scoringHistory`).
 */
export const PrioritySnapshotSchema = z.strictObject({
  id: IdSchema,
  at: EpochMs,
  titles: z.array(Title).max(2000),
  confirmed: z.boolean().nullish(),
});
export type PrioritySnapshot = z.infer<typeof PrioritySnapshotSchema>;
