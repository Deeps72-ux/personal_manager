import { describe, expect, it } from "vitest";
import { deviationPercent, focusPercent, formatPercent, splitActivities, uuidv7, uuidv7Time } from "../src/index.ts";

const P = ["A", "B", "C"];
const D = (...logged: string[]) => deviationPercent(logged, P)!;

describe("splitActivities", () => {
  it("splits on ';', trims, drops empties and repeats (case-insensitive)", () => {
    expect(splitActivities("  X; C ;A;;a; ")).toEqual(["X", "C", "A"]);
    expect(splitActivities(";;  ;")).toEqual([]);
  });
});

describe("focusPercent", () => {
  it("is 100 / k", () => {
    expect(focusPercent(["A"])).toBe(100);
    expect(focusPercent(["X", "C", "A"])).toBeCloseTo(33.333, 3);
    expect(focusPercent([])).toBeNull();
  });
});

describe("deviationPercent", () => {
  it("is 0 only for the top priority alone", () => {
    expect(D("A")).toBe(0);
    expect(D("A", "B", "C")).toBeGreaterThan(0);
  });

  it("orders {A} < {A,…} < {B} < {B,…} < {C} < … < {X}", () => {
    const ordered = [D("A"), D("A", "B"), D("A", "B", "C"), D("A", "X"), D("X", "C", "A"), D("B"), D("B", "X"), D("C"), D("C", "X"), D("X")];
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]).toBeGreaterThan(ordered[i - 1]!);
  });

  it("matches the worked values (n = 3)", () => {
    expect(D("B")).toBe(25);
    expect(D("C")).toBe(50);
    expect(D("X")).toBe(75);
    expect(D("A", "X")).toBeCloseTo(20, 9);
    expect(D("X", "C", "A")).toBeCloseTo(23, 9);
  });

  it("matches titles ignoring case and spaces; stays below 100", () => {
    expect(deviationPercent([" a "], P)).toBe(0);
    expect(D("X", "Y", "Z")).toBeLessThan(100);
  });

  it("is null with nothing logged or an empty priority list", () => {
    expect(deviationPercent([], P)).toBeNull();
    expect(deviationPercent(["A"], [])).toBeNull();
  });
});

describe("helpers", () => {
  it("formatPercent keeps one decimal", () => {
    expect(formatPercent(33.3333)).toBe("33.3%");
    expect(formatPercent(25)).toBe("25%");
  });
  it("uuidv7Time reads back the creation time", () => {
    expect(uuidv7Time(uuidv7(1_763_500_000_123))).toBe(1_763_500_000_123);
  });
});
