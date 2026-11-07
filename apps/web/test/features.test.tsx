// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { activeFeatures, DEFAULT_FEATURE_ID, FEATURES, resolveFeatureId, type Feature } from "../src/ui/features.tsx";

const stub = (id: string, extra: Partial<Feature> = {}): Feature => ({
  id,
  label: id,
  Icon: () => <svg />,
  View: () => <div>{id}</div>,
  ...extra,
});

describe("feature registry", () => {
  it("ships Tasks, Priority, Log and Timer, with a default that exists", () => {
    expect(FEATURES.map((f) => f.id)).toEqual(["tasks", "priority", "log", "timer"]);
    expect(activeFeatures().some((f) => f.id === DEFAULT_FEATURE_ID)).toBe(true);
  });

  it("drops disabled features and rejects duplicate ids or an empty list", () => {
    expect(activeFeatures([stub("a"), stub("b", { enabled: false })]).map((f) => f.id)).toEqual(["a"]);
    expect(() => activeFeatures([stub("a"), stub("a")])).toThrow("Duplicate feature id: a");
    expect(() => activeFeatures([stub("a", { enabled: false })])).toThrow("No features enabled");
  });

  it("resolves the remembered tab: wanted, else default, else first", () => {
    const list = [stub("x"), stub(DEFAULT_FEATURE_ID)];
    expect(resolveFeatureId("x", list)).toBe("x");
    expect(resolveFeatureId("gone", list)).toBe(DEFAULT_FEATURE_ID);
    expect(resolveFeatureId(null, [stub("x"), stub("y")])).toBe("x");
  });
});
