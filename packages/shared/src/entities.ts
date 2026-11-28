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

/** Highest rank a card or folder can be given in PRIORITY. */
export const MAX_PRIORITY_RANK = 2000;

export const IdSchema = z.string().refine(isUuidV7, "must be a UUIDv7");
export const DaySchema = z.string().refine(isValidDay, "must be a real date YYYY-MM-DD");
export const RankSchema = z.string().refine(isValidRank, "must be a fractional-index key");

const Title = z.string().trim().min(1, "title is required").max(LIMITS.titleMax);
const Description = z.string().max(LIMITS.descriptionMax).nullable();

/**
 * `folderId` / `folderRank`: where the task sits in the TASKS tab (a folder,
 * null = top level) and its manual order there. `folderTop`: it sits in the
 * folder's "recent" area, above the sub-folders (new and moved-in tasks do,
 * until dragged out). They only shape the TASKS tab: every other screen
 * ignores them, except that cards show the name of the task's folder.
 * Missing/null rank = a task from an older version, ordered by its priority
 * rank until it is moved.
 */
export const TaskSchema = z.strictObject({
  id: IdSchema,
  title: Title,
  description: Description,
  dueDate: DaySchema.nullable(),
  folderId: IdSchema.nullish(),
  folderRank: RankSchema.nullish(),
  folderTop: z.boolean().nullish(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * A FOLDER in the TASKS tab. Folders nest (`parentId`, null = top level) and
 * have a manual order among their siblings (`rank`). They group tasks for
 * browsing only: they never change how tasks behave anywhere else.
 * A folder whose parent no longer exists (deleted on another device) shows
 * at the top level. `top`: it sits in its parent's "recent" area, mixed with
 * recent tasks and above the other folders (new and moved-in folders do,
 * until dragged out). `priority`: a PRIORITY rank the user gave the folder:
 * every task inside it (at any depth) takes it, the nearest ranked folder
 * winning. Missing/null = none.
 */
export const FolderSchema = z.strictObject({
  id: IdSchema,
  name: Title,
  parentId: IdSchema.nullable(),
  rank: RankSchema,
  top: z.boolean().nullish(),
  priority: z.int().min(1).max(MAX_PRIORITY_RANK).nullish(),
});
export type Folder = z.infer<typeof FolderSchema>;

const EpochMs = z.int().min(0).max(2 ** 48 - 1);

/**
 * Where a task sits in the PRIORITY list (separate from Task: SRP).
 * `queuedAt`: when the task was dropped into the WAITING QUEUE (epoch ms).
 * A queued task leaves the visible priority list but keeps its rank. The
 * queue is never part of the scoring order. Missing/null = not queued.
 * `userRank`: a rank the user typed on the card (ties allowed). Missing/null
 * = its position in the list. Erased by any drag, queueing or new task.
 * `ownRank`: the card left its ranked folder's group (dragged out of it):
 * its own rank (typed, else its position) wins over the folder's, until it
 * is dragged back among that folder's cards. Missing/null = false.
 */
export const PlacementSchema = z.strictObject({
  taskId: IdSchema,
  rank: RankSchema,
  queuedAt: EpochMs.nullish(),
  userRank: z.int().min(1).max(MAX_PRIORITY_RANK).nullish(),
  ownRank: z.boolean().nullish(),
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
 *
 * `ranks`: the rank of each title (same order, ties allowed). Missing/null
 * = an older snapshot: each title's rank is its position.
 */
export const PrioritySnapshotSchema = z
  .strictObject({
    id: IdSchema,
    at: EpochMs,
    titles: z.array(Title).max(2000),
    confirmed: z.boolean().nullish(),
    ranks: z.array(z.int().min(1).max(MAX_PRIORITY_RANK)).max(2000).nullish(),
  })
  .refine((s) => !s.ranks || s.ranks.length === s.titles.length, "ranks must match titles");
export type PrioritySnapshot = z.infer<typeof PrioritySnapshotSchema>;

/**
 * One card of a list kept for later (a SCHEDULED slot, or the list to go
 * back to when a slot ends). `folderId`: the folder whose rank the card
 * carries (its group); null = the card's own rank.
 */
export const PlanEntrySchema = z.strictObject({
  taskId: IdSchema,
  title: Title,
  rank: z.int().min(1).max(MAX_PRIORITY_RANK),
  folderId: IdSchema.nullable(),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

/** A list kept for later: its cards best first, and when it was taken (tasks made after it go on top). */
export const PlanListSchema = z.strictObject({
  savedAt: EpochMs,
  entries: z.array(PlanEntrySchema).max(2000),
});
export type PlanList = z.infer<typeof PlanListSchema>;

/**
 * A SCHEDULED priority list: from `startMs` to `endMs` (future when made;
 * slots never overlap) this list is the one in force. `list` is frozen when
 * saved (folder ranks included). At the start, a device makes it the
 * visible list and confirms it (a snapshot with the slot's id); `restore`
 * is the visible list it replaced, put back at the end (`restored` = done).
 */
export const PrioritySlotSchema = z
  .strictObject({
    id: IdSchema,
    startMs: EpochMs,
    endMs: EpochMs,
    list: PlanListSchema,
    restore: PlanListSchema.nullish(),
    restored: z.boolean().nullish(),
  })
  .refine((s) => s.endMs > s.startMs, "a slot must end after it starts");
export type PrioritySlot = z.infer<typeof PrioritySlotSchema>;
