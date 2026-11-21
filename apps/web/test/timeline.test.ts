import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry } from "@pm/shared";
import { dayLayout, findConflicts, firstFit, knownSpan, longestGap } from "../src/core/timeline.ts";
import { formatWait, heat } from "../src/ui/queue-heat.ts";

const DAY = "2026-11-20";
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const timed = (title: string, from: number, minutes: number, source: "timer" | "manual" = "manual"): LogEntry => ({
  id: uuidv7(from),
  day: DAY,
  seconds: minutes * 60,
  taskTitle: title,
  focus: null,
  deviation: null,
  startMs: from,
  source,
});

describe("knownSpan", () => {
  it("own start; older TIMER logs end when ✓ was pressed; older manual logs have no time", () => {
    expect(knownSpan(timed("A", at(9), 30))).toEqual({ start: at(9), end: at(9, 30) });
    const pressed = at(10);
    const oldTimer: LogEntry = { id: uuidv7(pressed), day: DAY, seconds: 1800, taskTitle: "A;B;", focus: 50, deviation: 10 };
    expect(knownSpan(oldTimer)).toEqual({ start: at(9, 30), end: at(10) });
    // the earlier-day part of a ✓ that crossed midnight ends at midnight
    const crossed: LogEntry = { ...oldTimer, day: "2026-11-19", seconds: 600 };
    expect(knownSpan(crossed)).toEqual({ start: at(0) - 600_000, end: at(0) });
    expect(knownSpan({ ...oldTimer, focus: null })).toBeNull();
  });
});

describe("dayLayout", () => {
  it("free time = the day minus logs minus the running timer; untimed logs pack from midnight", () => {
    const old: LogEntry = { id: uuidv7(at(23)), day: DAY, seconds: 3600, taskTitle: "old", focus: null, deviation: null };
    const layout = dayLayout(DAY, [timed("A", at(0, 30), 30), old], at(20));
    // A at 00:30–01:00; "old" (1 h) packs into 00:00–00:30 and 01:00–01:30; timer from 20:00
    expect(layout.busy).toEqual([
      { start: at(0), end: at(1, 30) },
      { start: at(20), end: at(24) },
    ]);
    expect(layout.free).toEqual([{ start: at(1, 30), end: at(20) }]);
    expect(layout.pieces.filter((p) => !p.exact).map((p) => [p.start, p.end])).toEqual([
      [at(0), at(0, 30)],
      [at(1), at(1, 30)],
    ]);
  });

  it("first fit takes the earliest gap that holds the whole duration", () => {
    const { free } = dayLayout(DAY, [timed("A", at(0, 20), 220)], at(5)); // free: 00:00–00:20, 04:00–05:00
    expect(firstFit(free, 50 * 60)).toBe(at(4));
    expect(firstFit(free, 10 * 60)).toBe(at(0));
    expect(firstFit(free, 61 * 60)).toBeNull();
    expect(longestGap(free)).toBe(3600);
  });
});

describe("findConflicts", () => {
  it("same-kind overlaps only; a timer over a manual log is the server's to settle", () => {
    const t1 = timed("T1", at(9), 60, "timer");
    const t2 = timed("T2", at(9, 30), 60, "timer");
    const m1 = timed("M1", at(14), 60);
    const m2 = timed("M2", at(14, 59), 10);
    const m3 = timed("M3", at(9, 15), 10); // under the timers: no conflict
    const adjacent = timed("M4", at(15, 9), 10); // touches m2's end: no conflict
    expect(findConflicts([t1, t2, m1, m2, m3, adjacent]).map((c) => [c.a.taskTitle, c.b.taskTitle])).toEqual([
      ["T1", "T2"],
      ["M1", "M2"],
    ]);
  });
});

describe("queue heat", () => {
  it("blue when queued, red at one hour, then a pulse that keeps quickening", () => {
    expect(heat(0)).toMatchObject({ level: 0, pulse: null, color: expect.stringMatching(/^hsl\(220 /) });
    expect(heat(30 * 60_000)).toMatchObject({ level: 0.5, pulse: null, color: expect.stringMatching(/^hsl\(290 /) });
    const red = heat(60 * 60_000);
    expect(red).toMatchObject({ level: 1, color: expect.stringMatching(/^hsl\(0 /) });
    const later = heat(3 * 60 * 60_000);
    expect(later.pulse!).toBeLessThan(red.pulse!);
    expect(later.glow).toBeGreaterThan(red.glow);
    expect(heat(100 * 60 * 60_000).pulse).toBe(0.35); // capped
  });

  it("formats the wait", () => {
    expect([45_000, 12 * 60_000, 65 * 60_000, 51 * 3600_000].map(formatWait)).toEqual(["45s", "12m", "1h 05m", "2d 3h"]);
  });
});
