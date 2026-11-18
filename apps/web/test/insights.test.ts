import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry } from "@pm/shared";
import { insightPoints, spanWindow, weightedMean } from "../src/core/insights.ts";

const row = (t: number, day: string, seconds: number, focus: number | null, deviation: number | null = null): LogEntry => ({
  id: uuidv7(t),
  day,
  seconds,
  taskTitle: "A;B;",
  focus,
  deviation,
});

describe("insightPoints", () => {
  it("one point per ✓ press: rows split at midnight merge, unscored rows are skipped", () => {
    const t = new Date(2026, 10, 6, 1, 0).getTime();
    const points = insightPoints([
      row(t, "2026-11-05", 3600, 50, 10),
      row(t, "2026-11-06", 3600, 50, 10),
      row(t - 5_000_000, "2026-11-05", 60, null),
    ]);
    expect(points).toEqual([{ t, title: "A;B;", seconds: 7200, focus: 50, deviation: 10 }]);
  });
});

describe("spanWindow", () => {
  const anchor = new Date(2026, 10, 19, 15, 0).getTime(); // Thu 19 Nov 2026
  it("day / week (Monday start) / month, moved by whole spans", () => {
    expect(spanWindow("day", anchor, -1)).toEqual({
      start: new Date(2026, 10, 18).getTime(),
      end: new Date(2026, 10, 19).getTime(),
    });
    expect(spanWindow("week", anchor, 0).start).toBe(new Date(2026, 10, 16).getTime());
    expect(spanWindow("month", anchor, 2)).toEqual({
      start: new Date(2027, 0, 1).getTime(),
      end: new Date(2027, 1, 1).getTime(),
    });
  });
});

describe("weightedMean", () => {
  it("weights by logged seconds and ignores nulls", () => {
    const p = (seconds: number, focus: number, deviation: number | null) => ({ t: 0, title: "", seconds, focus, deviation });
    const pts = [p(3000, 100, 0), p(1000, 20, null)];
    expect(weightedMean(pts, (x) => x.focus)).toBe(80);
    expect(weightedMean(pts, (x) => x.deviation)).toBe(0);
    expect(weightedMean([], (x) => x.focus)).toBeNull();
  });
});
