import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry } from "@pm/shared";
import {
  MAX_VIEW_MS,
  MIN_VIEW_MS,
  clampWindow,
  insightPoints,
  matchSpan,
  spanWindow,
  timeTicks,
  weightedMean,
  windowLabel,
  zoomWindow,
} from "../src/core/insights.ts";

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

describe("free zoom / pan", () => {
  const t0 = new Date(2026, 10, 19, 10, 0, 0).getTime();
  const win = (ms: number) => ({ start: t0, end: t0 + ms });

  it("ticks get finer as the view narrows: years → months → days → hours → minutes → seconds", () => {
    const labels = (ms: number) => timeTicks(win(ms), 8).map((t) => t.label);
    expect(labels(4 * 365 * 86_400_000)).toEqual(["2027", "2028", "2029", "2030"]);
    expect(labels(150 * 86_400_000)[0]).toBe("Dec");
    expect(labels(3 * 3600_000)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00"]);
    expect(labels(5 * 60_000)).toEqual(["10:00", "10:01", "10:02", "10:03", "10:04", "10:05"]);
    expect(labels(10_000)).toEqual(["10:00:00", "10:00:02", "10:00:04", "10:00:06", "10:00:08", "10:00:10"]);
    expect(timeTicks(win(10_000), 20).map((t) => t.t - t0)).toEqual([...Array(11).keys()].map((i) => i * 1000)); // 1 s least count
  });

  it("zoom keeps the anchor time in place and stops at 10 s / 10 years", () => {
    const w = win(3600_000);
    const anchor = t0 + 900_000; // a quarter in
    const z = zoomWindow(w, 0.5, anchor);
    expect(z.end - z.start).toBe(1800_000);
    expect((anchor - z.start) / (z.end - z.start)).toBeCloseTo(0.25, 9);
    expect(zoomWindow(win(20_000), 0.001).end - zoomWindow(win(20_000), 0.001).start).toBe(MIN_VIEW_MS);
    expect(zoomWindow(w, 1e9).end - zoomWindow(w, 1e9).start).toBe(MAX_VIEW_MS);
    expect(clampWindow(win(1)).end - clampWindow(win(1)).start).toBe(MIN_VIEW_MS);
  });

  it("presets are recognised; other windows get a range heading", () => {
    expect(matchSpan(spanWindow("week", t0, -3))).toBe("week");
    expect(matchSpan(win(3600_000))).toBeNull();
    expect(windowLabel(win(5 * 60_000))).toMatch(/10:00:00 – 10:05:00$/);
    expect(windowLabel(win(3 * 3600_000))).toMatch(/10:00 – 13:00$/);
  });
});
