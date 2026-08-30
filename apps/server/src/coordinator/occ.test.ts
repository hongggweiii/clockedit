import { describe, expect, it } from "vitest";
import { evaluateCommit, MAX_ATTEMPTS } from "./occ.js";
import { InMemoryVersionStore } from "./version-store.js";
import type { Task } from "../types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "t",
    description: "",
    role: "frontend",
    dependsOn: [],
    intent: { reads: ["r.ts"], writes: ["w.ts"] },
    state: "committing",
    attempt: 0,
    assignedAgentId: "a1",
    runId: "r1",
    readVersions: {},
    writtenPaths: null,
    lastError: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("occ", () => {
  it("commits when no versions conflict", async () => {
    const store = new InMemoryVersionStore();
    const task = makeTask();
    const outcome = await evaluateCommit({
      task,
      writtenPaths: ["w.ts"],
      versionStore: store,
    });
    expect(outcome.kind).toBe("committed");
  });

  it("retries on version mismatch", async () => {
    const store = new InMemoryVersionStore();
    store.forceBump("p1", "r.ts");
    const task = makeTask({ readVersions: { "r.ts": "v0" }, attempt: 0 });
    const outcome = await evaluateCommit({
      task,
      writtenPaths: [],
      versionStore: store,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind === "retry") {
      expect(outcome.attempt).toBe(1);
      expect(outcome.conflictedPaths).toEqual(["r.ts"]);
    }
  });

  it("freezes after MAX_ATTEMPTS-1 retries", async () => {
    const store = new InMemoryVersionStore();
    store.forceBump("p1", "r.ts");
    const task = makeTask({ readVersions: { "r.ts": "v0" }, attempt: MAX_ATTEMPTS - 1 });
    const outcome = await evaluateCommit({
      task,
      writtenPaths: [],
      versionStore: store,
    });
    expect(outcome.kind).toBe("frozen");
  });
});
