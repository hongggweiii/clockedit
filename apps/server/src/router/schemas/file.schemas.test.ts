import { describe, expect, it } from "vitest";
import { fileRefSchema, fileWriteSchema, uniquePaths } from "./file.schemas.js";

describe("file coordination schemas", () => {
  it("validates versioned file references and new-file writes", () => {
    expect(fileRefSchema.safeParse({ path: "src/App.tsx", version: 3 }).success).toBe(true);
    expect(fileWriteSchema.safeParse({ path: "new.ts", content: "", based_on: null }).success).toBe(true);
    expect(fileWriteSchema.safeParse({ path: "new.ts", content: "", based_on: -1 }).success).toBe(false);
  });

  it("rejects duplicate paths in a request", () => {
    const schema = uniquePaths(fileWriteSchema, (write) => write.path);
    expect(schema.safeParse([
      { path: "a.ts", content: "one", based_on: 1 },
      { path: "a.ts", content: "two", based_on: 1 },
    ]).success).toBe(false);
  });
});
