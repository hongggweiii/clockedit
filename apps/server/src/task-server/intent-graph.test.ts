import { describe, expect, it } from "vitest";
import { conflictsWithAny, writesOverlap } from "./intent-graph.js";

describe("intent-graph", () => {
  it("detects write/write overlap on exact path", () => {
    expect(writesOverlap(["src/api.ts"], ["src/api.ts"])?.path).toBe("src/api.ts");
  });

  it("no conflict for disjoint paths", () => {
    expect(writesOverlap(["a.ts"], ["b.ts"])).toBeNull();
  });

  it("no conflict when either side is empty", () => {
    expect(writesOverlap([], ["a.ts"])).toBeNull();
    expect(writesOverlap(["a.ts"], [])).toBeNull();
  });

  it("conflictsWithAny true when any other overlaps", () => {
    expect(conflictsWithAny(["a.ts"], [["x.ts"], ["a.ts"]])).toBe(true);
  });

  it("conflictsWithAny false when nothing overlaps", () => {
    expect(conflictsWithAny(["a.ts"], [["x.ts"], ["y.ts"]])).toBe(false);
  });
});
