import { describe, expect, it } from "vitest";
import {
  activityKey,
  deviationOverTime,
  hasTextAfterSeparator,
  hourFocus,
  parseActivity,
  rankDeviation,
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

  it("a log spanning a priority change is scored piece by piece, weighted by time", () => {
    const history = [
      { at: 0, titles: ["A", "X", "B", "C"] },
      { at: 30, titles: ["X", "A", "B", "C"] },
    ];
    // 0–30: A is #1 (0%); 30–60: A is #2 of 4 (20%) → 10%
    expect(deviationOverTime("A", 0, 60, history)).toBe(10);
    // The user's example: A then X, each while it was top → 0% overall
    expect(deviationOverTime("A", 0, 30, history)).toBe(0);
    expect(deviationOverTime("X", 30, 60, history)).toBe(0);
  });

  it("time before the first snapshot has no reference", () => {
    const history = [{ at: 50, titles: ["A", "B"] }];
    expect(deviationOverTime("B", 0, 40, history)).toBeNull();
    expect(deviationOverTime("B", 0, 100, history)).toBeCloseTo(100 / 3); // only 50–100 counts
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
