import { describe, expect, it } from "vitest";
import { evaluateCommit, MAX_STRIKES } from "./occ.js";
import { InMemoryFileStore } from "./version-store.js";
import type { InternalTask } from "./task.types.js";

function makeTask(overrides: Partial<InternalTask> = {}): InternalTask {
  return {
    id: "t1",
    detail: "t",
    state: "assigned",
    owner: "a1",
    depends_on: [],
    writes: ["w.ts"],
    strikes: 0,
    read_versions: null,
    created_at: "",
    updated_at: "",
    assigned_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("occ", () => {
  it("commits when read + write versions match", async () => {
    const store = new InMemoryFileStore();
    const task = makeTask();
    const outcome = await evaluateCommit({
      task,
      agentId: "a1",
      reads: [],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore: store,
    });
    expect(outcome.kind).toBe("committed");
  });

  it("retries on stale read version", async () => {
    const store = new InMemoryFileStore();
    store.forceBump("r.ts"); // head is now v0; agent thinks it's -1 (never fetched)
    const task = makeTask({ strikes: 0 });
    const outcome = await evaluateCommit({
      task,
      agentId: "a1",
      reads: [{ path: "r.ts", version: 999 }],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore: store,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind === "retry") {
      expect(outcome.strikes).toBe(1);
      expect(outcome.conflictedPaths).toEqual(["r.ts"]);
    }
  });

  it("escalates after MAX_STRIKES-1 retries", async () => {
    const store = new InMemoryFileStore();
    store.forceBump("r.ts");
    const task = makeTask({ strikes: MAX_STRIKES - 1 });
    const outcome = await evaluateCommit({
      task,
      agentId: "a1",
      reads: [{ path: "r.ts", version: 42 }],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore: store,
    });
    expect(outcome.kind).toBe("exhausted");
  });

  it("rejects when a write's based_on doesn't match head", async () => {
    const store = new InMemoryFileStore();
    store.forceBump("w.ts"); // head is now v0
    const task = makeTask();
    const outcome = await evaluateCommit({
      task,
      agentId: "a1",
      reads: [],
      writes: [{ path: "w.ts", content: "hi", based_on: null }], // saying "should not exist"
      fileStore: store,
    });
    expect(outcome.kind).toBe("retry");
  });
});
