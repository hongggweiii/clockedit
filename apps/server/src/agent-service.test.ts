import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { Router } from "./router/router.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  router?: Router,
  coordination?: {
    baseUrl: string;
    runtimeBaseUrl?: string;
    projectId: string;
    taskId: string | null;
    authToken?: string;
  },
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    router,
    coordination,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("exposes created agent profiles to the coordination layer", async () => {
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    const service = await makeService(new FakeRunner(), router);
    const agent = await service.createAgent({ name: "Coordinated" });

    expect(service.getAgentProfile(agent.id)).toEqual({ id: agent.id, description: "" });
    await service.deleteAgent(agent.id);
    expect(service.getAgentProfile(agent.id)).toBeNull();
  });

  it("rolls back the Agent when its initial SSE connection cannot be established", async () => {
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    const service = await makeService(new FakeRunner(), router, {
      baseUrl: "http://127.0.0.1:1",
      projectId: "test",
      taskId: null,
    });

    await expect(service.createAgent({ name: "Unavailable" })).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining("SSE connection could not be established"),
    });
    expect(service.listAgents()).toEqual([]);
  });

  it("can initialize repeatedly without changing agent profiles", async () => {
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    const service = await makeService(new FakeRunner(), router);
    const agent = await service.createAgent({ name: "Idempotent" });

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.getAgentProfile(agent.id)).toEqual({ id: agent.id, description: "" });
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("scopes a dispatched run to its task id", async () => {
    let received: RunnerRequest | undefined;
    const runner: AgentRunner = {
      run: async (request) => {
        received = request;
        return { output: "done", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner, undefined, {
      baseUrl: "http://127.0.0.1:4000",
      projectId: "demo",
      taskId: null,
    });
    const agent = await service.createAgent({ name: "Worker" });
    const { run } = await service.sendMessage(agent.id, "do T1", "T1");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(received?.coordination?.taskId).toBe("T1");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
