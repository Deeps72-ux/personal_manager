import { describe, expect, it } from "vitest";
import { DAY_SECONDS, daysInMonth, isValidDay, todayLocal } from "../src/day.ts";
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
