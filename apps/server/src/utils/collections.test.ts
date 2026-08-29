import { describe, expect, it } from "vitest";
import { hasDuplicates } from "./collections.js";

describe("collection utilities", () => {
  it("detects duplicate values", () => {
    expect(hasDuplicates(["a", "b"])).toBe(false);
    expect(hasDuplicates(["a", "a"])).toBe(true);
  });
});
