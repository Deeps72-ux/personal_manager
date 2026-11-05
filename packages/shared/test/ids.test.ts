import { describe, expect, it } from "vitest";
import { isUuidV7, uuidv7 } from "../src/ids.ts";

describe("uuidv7", () => {
  it("produces a valid v7 UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(isUuidV7(id)).toBe(true);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const zeros = () => new Uint8Array(10);
    expect(uuidv7(0x0192f3a47b1c, zeros)).toBe("0192f3a4-7b1c-7000-8000-000000000000");
  });

  it("sorts by creation time across milliseconds", () => {
    const ids = [3, 1, 2].map((t) => uuidv7(1_700_000_000_000 + t));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("does not collide across many generations", () => {
    const set = new Set(Array.from({ length: 10_000 }, () => uuidv7(1_700_000_000_000)));
    expect(set.size).toBe(10_000);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });

  it("isUuidV7 rejects other versions and junk", () => {
    expect(isUuidV7("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // v4
    expect(isUuidV7("0192F3A4-7B1C-7000-8000-000000000000")).toBe(false); // uppercase
    expect(isUuidV7("not-a-uuid")).toBe(false);
  });
});
