import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent, AgentRunner } from "../types.js";
import { AgentService } from "../agent-service.js";
import { WorkspaceManager } from "../workspace.js";
import { Coordinator } from "./coordinator.js";
import { TaskStore } from "./task-store.js";
import { InMemoryVersionStore } from "./version-store.js";

const fakeRunner: AgentRunner = {
  async run() {
    return { output: "ok", threadId: "t", usage: null };
  },
  async cancel() {
    return true;
  },
  async isAvailable() {
    return true;
  },
};

function makeAgent(role: string): Agent {
  return {
    id: crypto.randomUUID(),
    name: role,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: `/tmp/${role}`,
    codexThreadId: null,
    lastError: null,
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

describe("HTTP boundary: coordination routes", () => {
  let dir: string;
  let store: JsonStore;
  let taskStore: TaskStore;
  let versionStore: InMemoryVersionStore;
  let coordinator: Coordinator;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "route-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dir,
      AGENT_WORKSPACE_ROOT: path.join(dir, "workspaces"),
      ARK_API_KEY: "x",
      ARK_MODEL: "ep-1",
    });
    store = new JsonStore(path.join(dir, "db.json"));
    await store.initialize();
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const service = new AgentService(config, store, workspaces, fakeRunner);
    await service.initialize();
    taskStore = new TaskStore(store);
    versionStore = new InMemoryVersionStore();
    coordinator = new Coordinator({
      store,
      taskStore,
      versionStore,
      executor: {
        async execute({ task }) {
          return { runId: `run-${task.id}`, writtenPaths: task.intent.writes };
        },
      },
    });
    // Seed one agent per role.
    await store.mutate((db) => {
      db.agents.push(makeAgent("frontend"), makeAgent("backend"));
    });
    app = await createApp(config, service, coordinator, taskStore);
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a valid project, executes tasks, exposes state via GET", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "demo",
        tasks: [
          { id: "t1", title: "Front work", description: "Do frontend", role: "frontend", dependsOn: [], intent: { reads: [], writes: ["ui.ts"] } },
          { id: "t2", title: "Back work", description: "Do backend", role: "backend", dependsOn: ["t1"], intent: { reads: ["ui.ts"], writes: ["api.ts"] } },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { project: { id: string } };
    const projectId = body.project.id;

    await waitUntil(() =>
      store.snapshot().tasks.every((t) => t.state === "completed"),
    );

    const get = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    expect(get.statusCode).toBe(200);
    const detail = get.json() as { tasks: Array<{ state: string }> };
    expect(detail.tasks.every((t) => t.state === "completed")).toBe(true);
  });

  it("rejects a cyclic DAG with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "bad",
        tasks: [
          { id: "a", title: "a", description: "d", role: "frontend", dependsOn: ["b"], intent: { reads: [], writes: [] } },
          { id: "b", title: "b", description: "d", role: "frontend", dependsOn: ["a"], intent: { reads: [], writes: [] } },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

});
