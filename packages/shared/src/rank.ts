/**
 * Fractional ranks for the PRIORITY list.
 *
 * Each card has a sortable string ("a0", "a0V", "a1"...). Moving a card only
 * changes THAT card's rank, never its neighbours, so two offline devices
 * reordering different cards never conflict.
 *
 * The UI does no computation beyond asking "give me a key between these two".
 */
import { generateKeyBetween } from "fractional-indexing";

export type Rank = string;

export interface Ranked {
  id: string;
  rank: Rank;
}

/**
 * Sort order used EVERYWHERE (server and every device): by rank, then id.
 * Plain code-unit comparison on purpose: ranks are ASCII base-62 and
 * `localeCompare` would order them differently on different devices.
 */
export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Rank for a brand-new card: placed above the current first card. */
export function rankForTop(sortedRanks: readonly Rank[]): Rank {
  return rankAt(sortedRanks, 0);
}

/**
 * Rank for a card dropped at `index` of a list that does NOT contain the
 * card being moved (remove it first, then ask for its new slot).
 *
 * If two devices once generated the same rank (possible when both were
 * offline), neighbours can be equal. A key strictly between equal keys does
 * not exist, so we place the card right after the run of equal ranks
 * instead of throwing. Order stays deterministic everywhere thanks to the
 * id tie-break in `compareRanked`.
 */
export function rankAt(sortedRanks: readonly Rank[], index: number): Rank {
  if (!Number.isInteger(index) || index < 0 || index > sortedRanks.length) {
    throw new RangeError(`index ${index} out of range 0..${sortedRanks.length}`);
  }
  const before = index > 0 ? sortedRanks[index - 1]! : null;
  let j = index;
  while (before !== null && j < sortedRanks.length && sortedRanks[j]! <= before) j++;
  const after = j < sortedRanks.length ? sortedRanks[j]! : null;
  return generateKeyBetween(before, after);
}

/** True if the string is a well-formed fractional-index key. */
export function isValidRank(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}
