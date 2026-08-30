import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../storage/file-store.js";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { Coordinator, DagRejected } from "./coordinator.js";
import { TaskStore } from "./task-store.js";
import { NoopPushAdapter } from "./push-adapter.js";
import type { NewTask } from "./task.types.js";

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

function makeAgent(id: string): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: `/tmp/${id}`,
    codexThreadId: null,
    lastError: null,
    role: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Coordinator (push model, real FileStore)", () => {
  let dir: string;
  let store: JsonStore;
  let taskStore: TaskStore;
  let fileStore: FileStore;
  let pushAdapter: NoopPushAdapter;
  let coordinator: Coordinator;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "coord-"));
    store = new JsonStore(path.join(dir, "db.json"));
    await store.initialize();
    await store.mutate((db) => {
      db.agents.push(makeAgent("a1"), makeAgent("a2"));
    });
    taskStore = new TaskStore(store);
    fileStore = new FileStore(store);
    pushAdapter = new NoopPushAdapter();
    coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const newTask = (over: Partial<NewTask> & Pick<NewTask, "id" | "owner">): NewTask => ({
    detail: over.id,
    depends_on: [],
    writes: [],
    ...over,
  });

  it("dispatches an unassigned task to its idle owner", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1" })]);
    await waitUntil(() => pushAdapter.sent.length === 1);
    expect(pushAdapter.sent[0]).toEqual({ taskId: "t1", ownerId: "a1" });
    expect(taskStore.get("t1")!.state).toBe("assigned");
  });

  it("commit + done drives task to done and unblocks dependents", async () => {
    await coordinator.submitTasks([
      newTask({ id: "t1", owner: "a1" }),
      newTask({ id: "t2", owner: "a2", depends_on: ["t1"] }),
    ]);
    await waitUntil(() => pushAdapter.sent.length === 1);

    const response = await coordinator.onCommit("a1", "t1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "shared.ts", content: "hello", based_on: null }],
    });
    expect(response.ok).toBe(true);
    await coordinator.onDone("a1", "t1", { kind: "done" });

    await waitUntil(() => pushAdapter.sent.length === 2);
    expect(pushAdapter.sent[1]).toEqual({ taskId: "t2", ownerId: "a2" });
    expect(taskStore.get("t1")!.state).toBe("done");
  });

  it("STALE commit keeps the task assigned (immediate retry)", async () => {
    // Seed a file so 'w.ts' exists at v1, then agent tries to write as if it were absent.
    await fileStore.commit("seeder", "seed", [{ path: "w.ts", content: "seed", based_on: null }]);
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1", writes: ["w.ts"] })]);
    await waitUntil(() => pushAdapter.sent.length === 1);

    const response = await coordinator.onCommit("a1", "t1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "w.ts", content: "x", based_on: null }],
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.code).toBe("STALE");
      expect(response.moved.length).toBeGreaterThan(0);
    }
    // Task stays assigned; strikes++; no re-dispatch.
    expect(taskStore.get("t1")!.state).toBe("assigned");
    expect(taskStore.get("t1")!.strikes).toBe(1);
    expect(pushAdapter.sent).toHaveLength(1);
  });

  it("keeps returning STALE indefinitely on repeated conflicts (no escalation)", async () => {
    await fileStore.commit("seeder", "seed", [{ path: "w.ts", content: "seed", based_on: null }]);
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1", writes: ["w.ts"] })]);
    await waitUntil(() => pushAdapter.sent.length === 1);

    for (let i = 0; i < 10; i++) {
      const response = await coordinator.onCommit("a1", "t1", {
        kind: "commit",
        reads: [],
        writes: [{ path: "w.ts", content: "x", based_on: null }],
      });
      expect(response.ok).toBe(false);
    }
    // Task remains assigned; strikes reflect attempts; no escalation.
    expect(taskStore.get("t1")!.state).toBe("assigned");
    expect(taskStore.get("t1")!.strikes).toBe(10);
    expect(pushAdapter.sent).toHaveLength(1);
  });

  it("onFetch returns found files (Router handles missing → NOT_FOUND)", async () => {
    await fileStore.commit("seeder", "seed", [{ path: "r.ts", content: "hello", based_on: null }]);
    const files = await coordinator.onFetch("a1", { kind: "fetch", paths: ["r.ts", "ghost.ts"] });
    expect(files).toEqual([{ path: "r.ts", version: 1, content: "hello" }]);
  });

  it("listFiles enumerates the FileStore", async () => {
    const list = await coordinator.listFiles("a1", { kind: "list_files" });
    // Demo files ship with the store.
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("path");
    expect(list[0]).toHaveProperty("version");
  });

  it("rejects a cyclic DAG", async () => {
    await expect(
      coordinator.submitTasks([
        newTask({ id: "a", owner: "a1", depends_on: ["b"] }),
        newTask({ id: "b", owner: "a1", depends_on: ["a"] }),
      ]),
    ).rejects.toBeInstanceOf(DagRejected);
  });

  it("rejects a task with an unknown owner", async () => {
    await expect(
      coordinator.submitTasks([newTask({ id: "t1", owner: "ghost" })]),
    ).rejects.toBeInstanceOf(DagRejected);
  });

  it("commit throws when the caller isn't the owner", async () => {
    await coordinator.submitTasks([newTask({ id: "t2", owner: "a2" })]);
    await waitUntil(() => taskStore.get("t2")!.state === "assigned");
    await expect(
      coordinator.onCommit("a1", "t2", { kind: "commit", reads: [], writes: [{ path: "x.ts", content: "", based_on: null }] }),
    ).rejects.toThrow(/not the owner/);
  });

  it("createTasks appends agent-proposed tasks and returns their ids", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1" })]);
    await waitUntil(() => taskStore.get("t1")!.state === "assigned");
    const created = await coordinator.onCreateTasks("a1", {
      kind: "create_tasks",
      tasks: [{ id: "child", detail: "child of t1", owner: "a2", depends_on: ["t1"], writes: [] }],
    });
    expect(created).toEqual([{ id: "child" }]);
    expect(taskStore.get("child")!.state).toBe("blocked");
  });
});
