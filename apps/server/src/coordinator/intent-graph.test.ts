import { describe, expect, it } from "vitest";
import { conflictsWithAny, detectConflict } from "./intent-graph.js";

describe("intent-graph", () => {
  it("detects write/write on exact path", () => {
    expect(
      detectConflict(
        { reads: [], writes: ["src/api.ts"] },
        { reads: [], writes: ["src/api.ts"] },
      )?.kind,
    ).toBe("write-write");
  });

  it("detects write/read overlap", () => {
    const c = detectConflict(
      { reads: [], writes: ["src/api.ts"] },
      { reads: ["src/api.ts"], writes: [] },
    );
    expect(c?.kind).toBe("write-read");
  });

  it("no conflict for disjoint paths", () => {
    expect(
      detectConflict(
        { reads: [], writes: ["a.ts"] },
        { reads: [], writes: ["b.ts"] },
      ),
    ).toBeNull();
  });

  it("glob overlap: **/*.ts vs src/foo.ts", () => {
    expect(
      detectConflict(
        { reads: [], writes: ["**/*.ts"] },
        { reads: [], writes: ["src/foo.ts"] },
      ),
    ).not.toBeNull();
  });

  it("conflictsWithAny false when no others", () => {
    expect(conflictsWithAny({ reads: [], writes: ["a.ts"] }, [])).toBe(false);
  });
});
