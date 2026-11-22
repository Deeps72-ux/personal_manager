import { describe, expect, it } from "vitest";
import { cardLook, hueFor, safeHue, wordsHue } from "../src/ui/colors.ts";
import { cutAt, mergeCut, singleSegment } from "../src/core/split.ts";

const isRed = (h: number) => h < 25 || h >= 335;

describe("activity colours", () => {
  it("are never red: red means unlogged", () => {
    for (let h = -360; h < 720; h++) expect(isRed(safeHue(h))).toBe(false);
    for (let i = 0; i < 500; i++) {
      expect(isRed(cardLook(`id-${i}`).hue)).toBe(false);
      expect(isRed(wordsHue(`activity ${i}`))).toBe(false);
    }
  });

  it("a task's activity has its card's colour; anything else a steady colour of its own", () => {
    const tasks = [{ id: "t1", title: "Reading" }];
    expect(hueFor("reading;", tasks)).toBe(cardLook("t1").hue);
    expect(hueFor("Doomscrolling", tasks)).toBe(wordsHue("doomscrolling;"));
    expect(hueFor("Doomscrolling", [])).toBe(hueFor("Doomscrolling", tasks));
  });
});

describe("split: cut and merge", () => {
  const M = 60_000;
  it("cuts at a whole minute, nudged a minute off the edges; locked or too short: no cut", () => {
    const segs = singleSegment(0, 10 * M);
    expect(cutAt(segs, 4 * M + 20_000)!.map((s) => s.end)).toEqual([4 * M, 10 * M]);
    expect(cutAt(segs, 10_000)![0]!.end).toBe(M);
    expect(cutAt(segs, 10 * M - 1)![0]!.end).toBe(9 * M);
    expect(cutAt(singleSegment(0, M + 30_000), 40_000)).toBeNull();
    expect(cutAt([{ start: 0, end: 10 * M, locked: "Reading", text: "" }], 5 * M)).toBeNull();
  });

  it("merging keeps the label of the piece dragged into, else the other one's", () => {
    const segs = [
      { start: 0, end: M * 5, locked: null, text: "A" },
      { start: M * 5, end: M * 10, locked: null, text: "B" },
    ];
    expect(mergeCut(segs, 0, "right")).toEqual([{ start: 0, end: 10 * M, locked: null, text: "B" }]);
    expect(mergeCut(segs, 0, "left")![0]!.text).toBe("A");
    expect(mergeCut([segs[0]!, { ...segs[1]!, text: "" }], 0, "right")![0]!.text).toBe("A");
  });
});
