import { describe, expect, it } from "vitest";
import { topoSort, validateDag } from "./dag.js";

describe("dag", () => {
  it("topologically sorts a simple chain", () => {
    const { order, cycleNodes } = topoSort([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    expect(cycleNodes).toEqual([]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("detects a cycle", () => {
    const result = validateDag([
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "cycle")).toBe(true);
  });

  it("flags unknown dependencies", () => {
    const result = validateDag([
      { id: "a", dependsOn: ["ghost"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.kind === "unknown-dependency")).toBeTruthy();
  });

  it("flags duplicate ids", () => {
    const result = validateDag([
      { id: "a", dependsOn: [] },
      { id: "a", dependsOn: [] },
    ]);
    expect(result.errors.find((e) => e.kind === "duplicate-id")).toBeTruthy();
  });

  it("accepts a valid diamond", () => {
    const result = validateDag([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.topoOrder.indexOf("a")).toBeLessThan(result.topoOrder.indexOf("d"));
  });
});
