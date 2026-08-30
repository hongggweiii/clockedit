import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { installAgentTools } from "./agent-harness/agent-tools.js";
import { loadConfig } from "./config.js";
import { Router } from "./router/router.js";
import { createTaskServerApp } from "./task-server/app.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);

class RecordingRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    return {
      output: `interpreted: ${request.prompt}`,
      threadId: "integration-thread",
      usage: null,
    };
  }

  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("agent coordination lifecycle", () => {
  it("registers, communicates over SSE, and wakes for dispatched messages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-coordination-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      TASK_SERVER_AUTH_TOKEN: "task-secret",
    });
    const router = new Router({
      listFiles: async () => [{ path: "shared/spec.md", version: 1 }],
      onFetch: async (_agentId, request) => request.paths.map((filePath) => ({
        path: filePath,
        version: 1,
        content: "# shared spec\n",
      })),
      onCommit: async () => ({ ok: true, kind: "committed" }),
      onDone: async () => undefined,
    });
    const runner = new RecordingRunner();
    let service: AgentService | undefined;
    const taskServer = await createTaskServerApp(config, router, (agentId) =>
      service?.getAgentProfile(agentId) ?? null,
    );

    try {
      await taskServer.listen({ host: "127.0.0.1", port: 0 });
      const address = taskServer.server.address();
      if (!address || typeof address === "string") throw new Error("Task server did not bind");
      const coordinationBaseUrl = `http://127.0.0.1:${address.port}`;
      service = new AgentService(
        config,
        new JsonStore(path.join(root, "data", "launchpad.json")),
        new WorkspaceManager(path.join(root, "workspaces")),
        runner,
        router,
        { baseUrl: coordinationBaseUrl, projectId: "integration", taskId: null, authToken: "task-secret" },
      );
      await service.initialize();

      const agent = await service.createAgent({ name: "SSE Agent", description: "Handles coordination" });
      expect(router.hasAgent(agent.id)).toBe(true);

      await installAgentTools(agent.workspacePath);
      const commandEnvironment = {
        ...process.env,
        COORDINATION_BASE_URL: coordinationBaseUrl,
        COORDINATION_AUTH_TOKEN: "task-secret",
        COORDINATION_AGENT_ID: agent.id,
      };
      const runCtl = (...args: string[]) => execFileAsync(
        process.execPath,
        [path.resolve("src/agent-harness/agentctl.mjs"), ...args],
        { cwd: agent.workspacePath, env: commandEnvironment },
      );

      const profiles = await runCtl("list-agent");
      expect(JSON.parse(profiles.stdout)).toEqual({
        ok: true,
        kind: "agent_profiles",
        agents: [{ id: agent.id, description: "Handles coordination" }],
      });

      const fetched = await runCtl("fetch", "shared/spec.md");
      expect(JSON.parse(fetched.stdout)).toEqual({
        ok: true,
        kind: "files",
        files: [{ path: "shared/spec.md", version: 1, content: "# shared spec\n" }],
      });

      await router.dispatch(agent.id, { ok: true, kind: "tasks", task_ids: ["task-1"] });
      await expect.poll(() => service?.getRuns(agent.id).length).toBe(1);
      await expect.poll(() => service?.getRuns(agent.id)[0]?.status).toBe("completed");
      expect(runner.requests).toHaveLength(1);
      expect(runner.requests[0]?.prompt).toContain('"task_ids":["task-1"]');
      expect(service.getMessages(agent.id).at(-1)?.role).toBe("assistant");
    } finally {
      if (service) {
        for (const agent of service.listAgents()) await service.deleteAgent(agent.id);
      }
      await taskServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
