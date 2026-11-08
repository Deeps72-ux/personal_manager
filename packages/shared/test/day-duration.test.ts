import { describe, expect, it } from "vitest";
import { DAY_SECONDS, daysInMonth, isValidDay, splitByDay, todayLocal } from "../src/day.ts";
import { fitsInDay, formatSeconds, parseSecondsInput, sumSeconds } from "../src/duration.ts";

describe("day", () => {
  it("accepts real dates only", () => {
    expect(isValidDay("2026-11-05")).toBe(true);
    expect(isValidDay("2028-02-29")).toBe(true); // leap year
    expect(isValidDay("2026-02-29")).toBe(false);
    expect(isValidDay("2026-04-31")).toBe(false);
    expect(isValidDay("2026-13-01")).toBe(false);
    expect(isValidDay("2026-1-5")).toBe(false);
    expect(isValidDay("2026-11-05T00:00")).toBe(false);
  });

  it("daysInMonth", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("todayLocal uses the local calendar date", () => {
    expect(todayLocal(new Date(2026, 10, 5, 23, 59))).toBe("2026-11-05");
    expect(todayLocal(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("parseSecondsInput", () => {
  const ok = (input: string) => parseSecondsInput(input);

  it.each([
    ["27", 27],
    [" 27 ", 27],
    ["8*60*60", 28_800],
    ["8 * 60 * 60", 28_800],
    ["8x3600", 28_800],
    ["8×3600", 28_800],
    ["8h", 28_800],
    ["90m", 5_400],
    ["45s", 45],
    ["1h30m", 5_400],
    ["1h 30m 15s", 5_415],
    ["24h", DAY_SECONDS],
  ])("%s → %i", (input, expected) => {
    expect(ok(input)).toEqual({ ok: true, seconds: expected });
  });

  it.each(["", "0", "0*5", "86401", "25h", "abc", "8+1", "1.5", "-5", "h", "1m1h", "9".repeat(30), "2**10"])(
    "rejects %j",
    (input) => {
      expect(ok(input).ok).toBe(false);
    },
  );
});

describe("formatSeconds", () => {
  it.each([
    [0, "0s"],
    [27, "27s"],
    [28_827, "8h 27s"],
    [5_415, "1h 30m 15s"],
    [DAY_SECONDS, "24h"],
  ])("%i → %s", (n, s) => {
    expect(formatSeconds(n)).toBe(s);
  });
});

describe("24h rule (UI-only)", () => {
  it("allows exactly 24h, blocks one second more", () => {
    const day = [{ seconds: 28_800 }, { seconds: 27 }];
    const total = sumSeconds(day);
    expect(total).toBe(28_827);
    expect(fitsInDay(total, DAY_SECONDS - total)).toBe(true);
    expect(fitsInDay(total, DAY_SECONDS - total + 1)).toBe(false);
  });
});

describe("splitByDay", () => {
  // Local times, so the tests pass in any timezone.
  const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime();

  it("same day: one part", () => {
    expect(splitByDay(at(5, 9), at(5, 10, 30))).toEqual([{ day: "2026-11-05", seconds: 5400 }]);
  });

  it("across midnight: each day gets its own share", () => {
    expect(splitByDay(at(5, 23), at(6, 1, 15))).toEqual([
      { day: "2026-11-05", seconds: 3600 },
      { day: "2026-11-06", seconds: 4500 },
    ]);
  });

  it("three or more days: full days in the middle", () => {
    const parts = splitByDay(at(5, 22), at(8, 2));
    expect(parts.map((p) => p.day)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(parts.map((p) => p.seconds)).toEqual([7200, DAY_SECONDS, DAY_SECONDS, 7200]);
  });

  it("empty or backwards span, and sub-second slivers, give nothing", () => {
    expect(splitByDay(at(5, 9), at(5, 9))).toEqual([]);
    expect(splitByDay(at(5, 10), at(5, 9))).toEqual([]);
    expect(splitByDay(at(5, 9), at(5, 9) + 999)).toEqual([]);
    // ends 0.5 s after midnight: the next day's sliver is dropped
    expect(splitByDay(at(5, 23, 59, 59), at(6, 0) + 500)).toEqual([{ day: "2026-11-05", seconds: 1 }]);
  });

  it("parts never exceed 24 hours (clock-change days)", () => {
    for (const p of splitByDay(at(1, 0), at(30, 0))) expect(p.seconds).toBeLessThanOrEqual(DAY_SECONDS);
  });
});
