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
import { InMemoryFileStore } from "./version-store.js";
import { NoopPushAdapter } from "./push-adapter.js";

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

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitUntil timed out");
}

describe("HTTP: task-server routes", () => {
  let dir: string;
  let store: JsonStore;
  let taskStore: TaskStore;
  let coordinator: Coordinator;
  let pushAdapter: NoopPushAdapter;
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
    const fileStore = new InMemoryFileStore();
    pushAdapter = new NoopPushAdapter();
    coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });
    await store.mutate((db) => {
      db.agents.push(makeAgent("a1"), makeAgent("a2"));
    });
    app = await createApp(config, service, coordinator, taskStore);
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("POST /api/tasks accepts and dispatches", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        tasks: [
          { id: "t1", detail: "front", owner: "a1", depends_on: [], writes: ["ui.ts"] },
          { id: "t2", detail: "back", owner: "a2", depends_on: ["t1"], writes: ["api.ts"] },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    await waitUntil(() => pushAdapter.sent.length === 1);
    expect(pushAdapter.sent[0]).toEqual({ taskId: "t1", ownerId: "a1" });
  });

  it("GET /api/tasks returns the persisted list", async () => {
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { tasks: [{ id: "t1", detail: "d", owner: "a1", depends_on: [], writes: [] }] },
    });
    const get = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toContain("t1");
  });

  it("POST /api/tasks rejects a cyclic DAG with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        tasks: [
          { id: "a", detail: "d", owner: "a1", depends_on: ["b"], writes: [] },
          { id: "b", detail: "d", owner: "a1", depends_on: ["a"], writes: [] },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
