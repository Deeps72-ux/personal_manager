import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry } from "@pm/shared";
import {
  MAX_VIEW_MS,
  MIN_VIEW_MS,
  clampWindow,
  deviationPoints,
  focusPoints,
  logDeviation,
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

const DAY = "2026-11-20";
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const timed = (title: string, from: number, minutes: number, source: "timer" | "manual" = "timer"): LogEntry => ({
  id: uuidv7(from),
  day: DAY,
  seconds: minutes * 60,
  taskTitle: title,
  focus: null,
  deviation: null,
  startMs: from,
  source,
});

describe("deviationPoints", () => {
  it("older ✓ rows split at midnight merge; unscored older rows are skipped", () => {
    const t = new Date(2026, 10, 6, 1, 0).getTime();
    const points = deviationPoints(
      [row(t, "2026-11-05", 3600, 50, 10), row(t, "2026-11-06", 3600, 50, 10), row(t - 5_000_000, "2026-11-05", 60, null)],
      [],
    );
    expect(points).toEqual([{ key: `d:${t}|A;B;`, t, seconds: 7200, value: 10, title: "A;B;", detail: "✓ pressed" }]);
  });

  it("a timed log (timer or manual) is scored against the order(s) in force while it ran", () => {
    const history = [
      { at: at(10), titles: ["A", "X", "B", "C"] },
      { at: at(10, 30), titles: ["X", "A", "B", "C"] },
    ];
    expect(logDeviation(timed("A", at(10), 60), history)).toBe(10);
    expect(logDeviation(timed("A", at(10), 30, "manual"), history)).toBe(0);
    expect(logDeviation(timed("X", at(10, 30), 30, "manual"), history)).toBe(0);
    expect(logDeviation(timed("A", at(9), 30), history)).toBeNull(); // before the history began
    const [p] = deviationPoints([timed("A", at(10), 60)], history);
    expect(p).toMatchObject({ t: at(11), value: 10, title: "A", detail: "10:00 – 11:00" });
  });
});

describe("focusPoints (per clock hour)", () => {
  const now = at(23);
  it("one activity all hour = 100%; every switch, and every gap, counts", () => {
    const pts = focusPoints(
      [
        timed("A", at(9), 60), // 09:00–10:00: A only → 0 switches
        timed("A", at(10), 20),
        timed("B", at(10, 20), 20), // 10:00–10:40: A, B
        timed("B", at(10, 50), 10), // 10:40–10:50 gap, then B again → A, B, gap, B = 3 switches
      ],
      null,
      now,
    );
    expect(pts.map((p) => [p.title, p.value, p.detail])).toEqual([
      ["09:00 – 10:00", 100, "0 switches"],
      ["10:00 – 11:00", 25, "3 switches"],
    ]);
  });

  it("A, gap, B = 2 switches; the same activity across two logs is no switch", () => {
    const pts = focusPoints([timed("A", at(9), 20), timed("B", at(9, 40), 20), timed("C", at(11), 30), timed("c;", at(11, 30), 30)], null, now);
    expect(pts.map((p) => p.value)).toEqual([100 / 3, 100]);
  });

  it("a log spanning hours scores in each; the running timer and the future are not scored yet", () => {
    const pts = focusPoints([timed("A", at(9, 30), 60)], at(12), at(12, 30));
    expect(pts.map((p) => [p.title, p.value])).toEqual([
      ["09:00 – 10:00", 50], // gap 09:00–09:30, then A
      ["10:00 – 11:00", 50], // A until 10:30, then gap
    ]);
    // Hour 12 is the running timer's: nothing scored there even with a log in it.
    expect(focusPoints([timed("B", at(11, 50), 5)], at(12), at(12, 30)).map((p) => p.title)).toEqual(["11:00 – 12:00"]);
  });

  it("hours with only older untimed manual logs get no point", () => {
    const old: LogEntry = { id: uuidv7(at(20)), day: DAY, seconds: 3600, taskTitle: "old", focus: null, deviation: null };
    expect(focusPoints([old], null, now)).toEqual([]);
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
  it("weights by logged seconds", () => {
    const p = (seconds: number, value: number) => ({ key: String(value), t: 0, title: "", detail: "", seconds, value });
    expect(weightedMean([p(3000, 100), p(1000, 20)])).toBe(80);
    expect(weightedMean([])).toBeNull();
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
