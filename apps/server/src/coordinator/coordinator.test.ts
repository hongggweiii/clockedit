import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { Coordinator } from "./coordinator.js";
import { TaskStore } from "./task-store.js";
import { InMemoryVersionStore } from "./version-store.js";
import { createAgentPool } from "./agent-pool.js";

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

function makeAgent(id: string, role: string): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: `/tmp/${id}`,
    codexThreadId: null,
    lastError: null,
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("Coordinator integration", () => {
  let dir: string;
  let store: JsonStore;
  let taskStore: TaskStore;
  let versionStore: InMemoryVersionStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "coord-"));
    store = new JsonStore(path.join(dir, "db.json"));
    await store.initialize();
    taskStore = new TaskStore(store);
    versionStore = new InMemoryVersionStore();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedAgents(agents: Agent[]): Promise<void> {
    await store.mutate((db) => {
      db.agents.push(...agents);
    });
  }

  it("runs a linear DAG to completion", async () => {
    await seedAgents([makeAgent("af", "frontend"), makeAgent("ab", "backend")]);
    const executed: string[] = [];
    const coordinator = new Coordinator({
      store,
      taskStore,
      versionStore,
      executor: {
        async execute({ task }) {
          executed.push(task.id);
          return { runId: `run-${task.id}`, writtenPaths: task.intent.writes };
        },
      },
      agentPool: createAgentPool(() => store.snapshot().agents),
    });
    await coordinator.submitProject({
      name: "demo",
      workspacePath: path.join(dir, "ws"),
      tasks: [
        { id: "t1", title: "t1", description: "", role: "frontend", dependsOn: [], intent: { reads: [], writes: ["a.ts"] } },
        { id: "t2", title: "t2", description: "", role: "backend", dependsOn: ["t1"], intent: { reads: ["a.ts"], writes: ["b.ts"] } },
      ],
    });
    await waitUntil(() =>
      store.snapshot().tasks.every((t) => t.state === "completed"),
    );
    expect(executed).toEqual(["t1", "t2"]);
  });

  it("sequences two writers to the same file", async () => {
    await seedAgents([makeAgent("a1", "frontend"), makeAgent("a2", "frontend")]);
    const inflight = new Set<string>();
    const overlaps: string[] = [];
    const coordinator = new Coordinator({
      store,
      taskStore,
      versionStore,
      executor: {
        async execute({ task }) {
          inflight.add(task.id);
          if (inflight.size > 1) overlaps.push([...inflight].join(","));
          await new Promise((r) => setTimeout(r, 20));
          inflight.delete(task.id);
          return { runId: `run-${task.id}`, writtenPaths: task.intent.writes };
        },
      },
    });
    await coordinator.submitProject({
      name: "demo",
      workspacePath: path.join(dir, "ws"),
      tasks: [
        { id: "t1", title: "", description: "", role: "frontend", dependsOn: [], intent: { reads: [], writes: ["shared.ts"] } },
        { id: "t2", title: "", description: "", role: "frontend", dependsOn: [], intent: { reads: [], writes: ["shared.ts"] } },
      ],
    });
    await waitUntil(() =>
      store.snapshot().tasks.every((t) => t.state === "completed"),
    );
    expect(overlaps).toEqual([]);
  });

  it("retries on OCC conflict and fails at MAX_ATTEMPTS", async () => {
    await seedAgents([makeAgent("a1", "frontend")]);
    const coordinator = new Coordinator({
      store,
      taskStore,
      versionStore,
      executor: {
        async execute({ task }) {
          // Force a version bump between dispatch and commit for r.ts.
          versionStore.forceBump(task.projectId, "r.ts");
          return { runId: `run-${task.id}`, writtenPaths: [] };
        },
      },
    });
    // Prime r.ts so head() returns a version at dispatch time.
    // We'll do this by writing once via a fake commit.
    await coordinator.submitProject({
      name: "demo",
      workspacePath: path.join(dir, "ws"),
      tasks: [
        {
          id: "t1",
          title: "",
          description: "",
          role: "frontend",
          dependsOn: [],
          intent: { reads: ["r.ts"], writes: [] },
        },
      ],
    });
    // Seed r.ts version so head snapshot at dispatch has a real value.
    versionStore.forceBump(
      store.snapshot().projects[0]!.id,
      "r.ts",
    );
    await waitUntil(() => {
      const t = store.snapshot().tasks[0]!;
      return t.state === "failed";
    }, 8000);
    const t = store.snapshot().tasks[0]!;
    expect(t.attempt).toBeGreaterThanOrEqual(5);
  });

  it("rejects a cyclic DAG", async () => {
    await seedAgents([makeAgent("a1", "frontend")]);
    const coordinator = new Coordinator({
      store,
      taskStore,
      versionStore,
      executor: {
        async execute({ task }) {
          return { runId: `r-${task.id}`, writtenPaths: [] };
        },
      },
    });
    await expect(
      coordinator.submitProject({
        name: "cyclic",
        workspacePath: path.join(dir, "ws"),
        tasks: [
          { id: "a", title: "", description: "", role: "frontend", dependsOn: ["b"], intent: { reads: [], writes: [] } },
          { id: "b", title: "", description: "", role: "frontend", dependsOn: ["a"], intent: { reads: [], writes: [] } },
        ],
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
