import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../storage/file-store.js";
import { JsonStore } from "../store.js";
import { evaluateCommit } from "./occ.js";
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

describe("occ.evaluateCommit", () => {
  let dir: string;
  let store: JsonStore;
  let fileStore: FileStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "occ-"));
    store = new JsonStore(path.join(dir, "db.json"));
    await store.initialize();
    fileStore = new FileStore(store);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("commits when the write is a fresh file (based_on=null on absent path)", async () => {
    const outcome = await evaluateCommit({
      task: makeTask(),
      agentId: "a1",
      reads: [],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore,
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") expect(outcome.versions["w.ts"]).toBe(1);
  });

  it("retries when a declared read version is stale", async () => {
    // Prime a file so it has version 1.
    await fileStore.commit("seeder", "seed", [{ path: "r.ts", content: "seed", based_on: null }]);
    // Agent claims to have read version 0 (which no longer exists at head).
    const outcome = await evaluateCommit({
      task: makeTask({ strikes: 0 }),
      agentId: "a1",
      reads: [{ path: "r.ts", version: 0 }],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind === "retry") {
      expect(outcome.strikes).toBe(1);
      expect(outcome.moved[0]?.path).toBe("r.ts");
    }
  });

  it("keeps retrying regardless of strike count (no escalation)", async () => {
    await fileStore.commit("seeder", "seed", [{ path: "r.ts", content: "seed", based_on: null }]);
    const outcome = await evaluateCommit({
      task: makeTask({ strikes: 99 }),
      agentId: "a1",
      reads: [{ path: "r.ts", version: 0 }],
      writes: [{ path: "w.ts", content: "hi", based_on: null }],
      fileStore,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind === "retry") expect(outcome.strikes).toBe(100);
  });
});
