import { describe, expect, it } from "vitest";
import {
  activityKey,
  deviationSlices,
  hasTextAfterSeparator,
  hourFocus,
  parseActivity,
  rankDeviation,
  scoringHistory,
} from "../src/metrics.ts";
import { mergeIntervals, overlaps, subtractIntervals } from "../src/timeline.ts";

describe("one activity per log", () => {
  it("adds the closing ';' when it is left out, and keeps one activity", () => {
    expect(parseActivity("Reading")).toEqual({ ok: true, activity: "Reading" });
    expect(parseActivity("  Reading;  ")).toEqual({ ok: true, activity: "Reading" });
  });

  it("refuses anything after the ';' and empty text", () => {
    expect(parseActivity("Reading;Gym")).toMatchObject({ ok: false });
    expect(parseActivity("Reading; Gym;")).toMatchObject({ ok: false });
    expect(parseActivity("Reading;;")).toMatchObject({ ok: false });
    expect(parseActivity(" ; ")).toEqual({ ok: false, error: "Type what you did" });
  });

  it("accepts an existing task title that itself contains ';'", () => {
    expect(parseActivity("Read; write;", ["Read; write"])).toEqual({ ok: true, activity: "Read; write" });
  });

  it("spots typing after the separator", () => {
    expect(hasTextAfterSeparator("Reading;")).toBe(false);
    expect(hasTextAfterSeparator("Reading;  ")).toBe(false);
    expect(hasTextAfterSeparator("Reading;G")).toBe(true);
    expect(hasTextAfterSeparator("Reading")).toBe(false);
  });

  it("matches titles case-blind, with or without the ';'", () => {
    expect(activityKey(" Gym; ")).toBe(activityKey("gym"));
  });
});

describe("deviation from the priority history", () => {
  it("rank deviation: top = 0, unknown = n/(n+1), empty list = no reference", () => {
    expect(rankDeviation("A", ["A", "B", "C"])).toBe(0);
    expect(rankDeviation("b;", ["A", "B", "C"])).toBe(25);
    expect(rankDeviation("Z", ["A", "B", "C"])).toBe(75);
    expect(rankDeviation("A", [])).toBeNull();
  });

  it("a log spanning a priority change is cut into slices, each scored on its own (no average)", () => {
    const history = [
      { at: 0, titles: ["A", "X", "B", "C"], confirmed: true },
      { at: 30, titles: ["X", "A", "B", "C"], confirmed: true },
    ];
    // 0–30: A is #1 (0%); 30–60: A is #2 of 4 (20%)
    expect(deviationSlices("A", 0, 60, history)).toEqual([
      { start: 0, end: 30, top: "A", deviation: 0 },
      { start: 30, end: 60, top: "X", deviation: 20 },
    ]);
    expect(deviationSlices("X", 30, 60, history)).toEqual([{ start: 30, end: 60, top: "X", deviation: 0 }]);
  });

  it("not in the confirmed snapshot (queued, new, deleted, or no task at all) = the worst score", () => {
    const history = [{ at: 0, titles: ["A", "B", "C"], confirmed: true }];
    expect(deviationSlices("Doomscrolling", 0, 10, history)[0]!.deviation).toBe(75);
  });

  it("time before the first snapshot has no reference", () => {
    const history = [{ at: 50, titles: ["A", "B"], confirmed: true }];
    expect(deviationSlices("B", 0, 40, history)).toEqual([{ start: 0, end: 40, top: null, deviation: null }]);
    expect(deviationSlices("B", 0, 100, history)).toEqual([
      { start: 0, end: 50, top: null, deviation: null },
      { start: 50, end: 100, top: "A", deviation: 100 / 3 },
    ]);
  });

  it("legacy snapshots only count before the first confirmed one; later legacy ones (old devices) are ignored", () => {
    const history = [
      { at: 0, titles: ["Old"] },
      { at: 10, titles: ["Older device"] },
      { at: 20, titles: ["A", "B"], confirmed: true },
      { at: 30, titles: ["Sneaky"] }, // a not-yet-updated device kept snapshotting
      { at: 40, titles: ["B", "A"], confirmed: true },
    ];
    expect(scoringHistory(history).map((h) => h.at)).toEqual([0, 10, 20, 40]);
    expect(deviationSlices("A", 5, 50, history).map((s) => [s.start, s.end, s.top])).toEqual([
      [5, 10, "Old"],
      [10, 20, "Older device"],
      [20, 40, "A"],
      [40, 50, "B"],
    ]);
    expect(scoringHistory([{ at: 0, titles: ["x"] }])).toHaveLength(1); // nothing confirmed yet: legacy counts
  });

  it("focus per hour: 100 / (1 + switches)", () => {
    expect(hourFocus(0)).toBe(100);
    expect(hourFocus(1)).toBe(50);
    expect(hourFocus(3)).toBe(25);
  });
});

describe("intervals", () => {
  it("merge, overlap and subtract", () => {
    expect(mergeIntervals([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 3, end: 4 }])).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 8 },
    ]);
    expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
    expect(overlaps({ start: 0, end: 6 }, { start: 5, end: 9 })).toBe(true);
    expect(subtractIntervals({ start: 0, end: 100 }, [{ start: 20, end: 30 }, { start: 90, end: 120 }])).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 90 },
    ]);
    expect(subtractIntervals({ start: 10, end: 20 }, [{ start: 0, end: 50 }])).toEqual([]);
  });
});
