import { describe, expect, it } from "vitest";
import { compareRanked, isValidRank, rankAt, rankForTop, type Ranked } from "../src/rank.ts";

/** Helper: insert a new card at `index` and return the resulting order of ids. */
function insert(list: Ranked[], id: string, index: number): Ranked[] {
  const sorted = [...list].sort(compareRanked);
  const rank = rankAt(sorted.map((c) => c.rank), index);
  return [...sorted, { id, rank }].sort(compareRanked);
}

describe("rank", () => {
  it("first card in an empty list", () => {
    expect(rankForTop([])).toBe("a0");
  });

  it("new cards always go to the top", () => {
    let list: Ranked[] = [];
    for (const id of ["A", "B", "C"]) {
      const sorted = [...list].sort(compareRanked);
      list = [...list, { id, rank: rankForTop(sorted.map((c) => c.rank)) }];
    }
    expect(list.sort(compareRanked).map((c) => c.id)).toEqual(["C", "B", "A"]);
  });

  it("drops a card between two neighbours", () => {
    const list = [
      { id: "gym", rank: "a0" },
      { id: "read", rank: "a1" },
    ];
    const rank = rankAt(["a0", "a1"], 1);
    expect(rank > "a0" && rank < "a1").toBe(true);
    expect(insert(list, "email", 1).map((c) => c.id)).toEqual(["gym", "email", "read"]);
  });

  it("drops a card at the bottom", () => {
    const list = [{ id: "gym", rank: "a0" }];
    expect(insert(list, "x", 1).map((c) => c.id)).toEqual(["gym", "x"]);
  });

  it("survives many inserts into the same gap", () => {
    let list: Ranked[] = [
      { id: "first", rank: "a0" },
      { id: "last", rank: "a1" },
    ];
    for (let i = 0; i < 200; i++) list = insert(list, `n${i}`, 1);
    const ids = list.map((c) => c.id);
    expect(ids[0]).toBe("first");
    expect(ids.at(-1)).toBe("last");
    expect(ids[1]).toBe("n199"); // last inserted sits right after "first"
  });

  it("does not throw when two offline devices produced the same rank", () => {
    // Both devices put a card at the top of ["a0"] while offline → both "Zz".
    const sorted = [
      { id: "phone-card", rank: "Zz" },
      { id: "laptop-card", rank: "Zz" },
      { id: "old", rank: "a0" },
    ].sort(compareRanked);
    expect(sorted.map((c) => c.id)).toEqual(["laptop-card", "phone-card", "old"]); // id tie-break
    // Dropping between the two equal ranks must not throw; it lands after the tie.
    const rank = rankAt(sorted.map((c) => c.rank), 1);
    expect(rank > "Zz" && rank < "a0").toBe(true);
  });

  it("rejects out-of-range indexes", () => {
    expect(() => rankAt(["a0"], 2)).toThrow(RangeError);
    expect(() => rankAt(["a0"], -1)).toThrow(RangeError);
  });

  it("compares by code units, not locale", () => {
    expect(compareRanked({ id: "x", rank: "Zz" }, { id: "y", rank: "a0" })).toBe(-1);
  });

  it("validates rank strings", () => {
    expect(isValidRank("a0")).toBe(true);
    expect(isValidRank("a0V")).toBe(true);
    expect(isValidRank("")).toBe(false);
    expect(isValidRank("a")).toBe(false);
    expect(isValidRank("!!")).toBe(false);
  });
});
