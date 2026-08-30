import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { Coordinator, DagRejected } from "./coordinator.js";
import { TaskStore } from "./task-store.js";
import { InMemoryFileStore } from "./version-store.js";
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

describe("Coordinator (push model)", () => {
  let dir: string;
  let store: JsonStore;
  let taskStore: TaskStore;
  let fileStore: InMemoryFileStore;
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
    fileStore = new InMemoryFileStore();
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

  it("dispatches an unassigned task and pushes to its owner", async () => {
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

    // Agent a1 commits.
    const commit = await coordinator.onCommit("a1", "t1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "shared.ts", content: "hello", based_on: null }],
    });
    expect(commit.ok).toBe(true);
    await coordinator.onDone("a1", "t1", { kind: "done" });

    // Now t2 should be dispatched to a2.
    await waitUntil(() => pushAdapter.sent.length === 2);
    expect(pushAdapter.sent[1]).toEqual({ taskId: "t2", ownerId: "a2" });
    expect(taskStore.get("t1")!.state).toBe("done");
  });

  it("stale commit sends the task back to unassigned for retry", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1", writes: ["w.ts"] })]);
    await waitUntil(() => pushAdapter.sent.length === 1);

    // External writer bumps the file's head before commit.
    fileStore.forceBump("w.ts");

    const result = await coordinator.onCommit("a1", "t1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "w.ts", content: "x", based_on: null }],
    });
    expect(result.ok).toBe(false);
    expect(taskStore.get("t1")!.strikes).toBe(1);
    // After the void tick, the task may already be re-dispatched (assigned) or still unassigned.
    await waitUntil(() => ["unassigned", "assigned"].includes(taskStore.get("t1")!.state));
  });

  it("escalates after MAX_STRIKES conflicts", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1", writes: ["w.ts"] })]);
    await waitUntil(() => pushAdapter.sent.length === 1);
    fileStore.forceBump("w.ts");

    // Feed 3 stale commits in a row (task recycles back to unassigned each time).
    for (let i = 0; i < 3; i++) {
      await coordinator.onCommit("a1", "t1", {
        kind: "commit",
        reads: [],
        writes: [{ path: "w.ts", content: "x", based_on: null }],
      });
      // Between strikes the task returns to unassigned and re-dispatches on the next tick.
      if (taskStore.get("t1")!.state === "unassigned") {
        await waitUntil(() => taskStore.get("t1")!.state === "assigned", 500).catch(() => undefined);
      }
    }
    expect(taskStore.get("t1")!.state).toBe("escalated");
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

  it("onCommit throws for an unassigned task", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1" })]);
    // t1 is unassigned/assigned by now; before push completes it may be either.
    await coordinator.submitTasks([newTask({ id: "t2", owner: "a2" })]);
    await waitUntil(() => taskStore.get("t2")!.state === "assigned");
    await expect(
      coordinator.onCommit("a1", "t2", { kind: "commit", reads: [], writes: [{ path: "x.ts", content: "", based_on: null }] }),
    ).rejects.toThrow(/not the owner/);
  });

  it("onCreateTasks appends agent-proposed tasks", async () => {
    await coordinator.submitTasks([newTask({ id: "t1", owner: "a1" })]);
    await waitUntil(() => taskStore.get("t1")!.state === "assigned");
    await coordinator.onCreateTasks("a1", {
      kind: "create_tasks",
      tasks: [{ id: "child", detail: "child of t1", owner: "a2", depends_on: ["t1"], writes: [] }],
    });
    expect(taskStore.get("child")).not.toBeNull();
    expect(taskStore.get("child")!.state).toBe("blocked");
  });
});
