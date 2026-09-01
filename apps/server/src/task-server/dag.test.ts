import { describe, expect, it } from "vitest";
import { topoSort, validateDag } from "./dag.js";

describe("dag", () => {
  it("topologically sorts a simple chain", () => {
    const { order, cycleNodes } = topoSort([
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["b"] },
    ]);
    expect(cycleNodes).toEqual([]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("detects a cycle", () => {
    const result = validateDag([
      { id: "a", depends_on: ["c"] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["b"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "cycle")).toBe(true);
  });

  it("flags unknown dependencies", () => {
    const result = validateDag([{ id: "a", depends_on: ["ghost"] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.kind === "unknown-dependency")).toBeTruthy();
  });

  it("flags duplicate ids", () => {
    const result = validateDag([
      { id: "a", depends_on: [] },
      { id: "a", depends_on: [] },
    ]);
    expect(result.errors.find((e) => e.kind === "duplicate-id")).toBeTruthy();
  });

  it("accepts a valid diamond", () => {
    const result = validateDag([
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "d", depends_on: ["b", "c"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.topoOrder.indexOf("a")).toBeLessThan(result.topoOrder.indexOf("d"));
  });

  it("treats existing ids as valid dep targets", () => {
    const result = validateDag(
      [{ id: "new1", depends_on: ["existing"] }],
      new Set(["existing"]),
    );
    expect(result.ok).toBe(true);
  });
});
