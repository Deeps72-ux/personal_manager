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

/** Where a task sits in the PRIORITY list (separate from Task: SRP). */
export const PlacementSchema = z.strictObject({
  taskId: IdSchema,
  rank: RankSchema,
});
export type Placement = z.infer<typeof PlacementSchema>;

/**
 * One LOG row. Holds a COPY of the task title, not a task id: deleting or
 * renaming a task never touches past logs.
 */
export const LogEntrySchema = z.strictObject({
  id: IdSchema,
  day: DaySchema,
  seconds: z.int().min(1).max(DAY_SECONDS),
  taskTitle: Title,
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
