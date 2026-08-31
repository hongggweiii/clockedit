import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createRouter } from "../router/router.js";
import { FileStore } from "../storage/file-store.js";
import { JsonStore } from "../store.js";
import { createTaskServerApp } from "../task-server/app.js";
import { Coordinator } from "../task-server/coordinator.js";
import { NoopPushAdapter } from "../task-server/push-adapter.js";
import { TaskStore } from "../task-server/task-store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import type { FastifyInstance } from "fastify";

/**
 * Scenario 1 driven end-to-end over real HTTP:
 *  - POST /api/agents to seed backend/frontend/qa (Kelly's SSE loopback fires)
 *  - POST /api/tasks to submit the DAG
 *  - POST /messages on the task-server to drive each agent step
 *  - GET /api/tasks to observe state transitions
 *
 * The push adapter is NoopPushAdapter, so the coordinator marks tasks
 * `assigned` but doesn't spawn Codex. The test itself acts as every agent,
 * proving that the wire path (Fastify + Router zod + FileStore) supports the
 * full flow.
 */

class InertRunner implements AgentRunner {
  async run(_request: RunnerRequest): Promise<RunnerResult> {
    return { output: "noop", threadId: "test-thread", usage: null };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

const envelope = (agentId: string, taskId: string | null, body: unknown) => ({
  msg_id: randomUUID(),
  agent: agentId,
  task_id: taskId,
  body,
});

describe("Demo scenario 1 — HTTP boundary", () => {
  let root: string;
  let app: FastifyInstance;
  let taskServer: FastifyInstance;
  let taskServerUrl: string;
  let publicToken: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "scenario1-http-"));
    publicToken = "public-secret";
    const taskToken = "task-secret";
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      APP_AUTH_TOKEN: publicToken,
      TASK_SERVER_AUTH_TOKEN: taskToken,
    });
    const store = new JsonStore(path.join(root, "data", "launchpad.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const taskStore = new TaskStore(store);
    const fileStore = new FileStore(store);
    const pushAdapter = new NoopPushAdapter();
    const coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });
    const router = createRouter(coordinator);

    // The task-server must be listening before AgentService opens its
    // loopback SSE for each newly created agent. Bind an ephemeral port.
    let service: AgentService;
    taskServer = await createTaskServerApp(config, router, (agentId) =>
      service?.getAgentProfile(agentId) ?? null,
    );
    await taskServer.listen({ host: "127.0.0.1", port: 0 });
    const address = taskServer.server.address();
    if (!address || typeof address === "string") throw new Error("Task server did not bind");
    taskServerUrl = `http://127.0.0.1:${address.port}`;

    service = new AgentService(config, store, workspaces, new InertRunner(), router, {
      baseUrl: taskServerUrl,
      projectId: "scenario-1",
      taskId: null,
      authToken: taskToken,
    });
    await service.initialize();

    app = await createApp(config, service, router, coordinator);
  });

  afterEach(async () => {
    await Promise.allSettled([app?.close(), taskServer?.close()]);
    await rm(root, { recursive: true, force: true });
  });

  it("drives T1 → T2 fetch → T4 → T2 STALE → T2 retry → T3 all via HTTP", async () => {
    // ─── Seed 3 agents via POST /api/agents ────────────────────────
    for (const [id, description] of [
      ["backend", "Owns the order API in repoB."],
      ["frontend", "Owns the web UI in repoA."],
      ["qa", "Reviews both repos and assigns fixes."],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${publicToken}`, "content-type": "application/json" },
        payload: { id, name: id, description },
      });
      expect(response.statusCode).toBe(201);
    }

    // ─── POST /api/tasks (T1 → T2 → T3) ────────────────────────────
    const submitInitial = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${publicToken}`, "content-type": "application/json" },
      payload: {
        tasks: [
          { id: "T1", owner: "backend", depends_on: [], writes: ["repoB/src/api/orders.ts"], detail: "backend adds cancelOrder" },
          { id: "T2", owner: "frontend", depends_on: ["T1"], writes: ["repoA/src/App.tsx"], detail: "frontend adds Cancel button" },
          { id: "T3", owner: "qa", depends_on: ["T2"], writes: ["qa/report.md"], detail: "qa PASS/FAIL report" },
        ],
      },
    });
    expect(submitInitial.statusCode).toBe(201);

    const getTasks = async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { authorization: `Bearer ${publicToken}` },
      });
      return (response.json() as { tasks: Array<{ id: string; state: string; strikes: number }> }).tasks;
    };
    // Coordinator.tick() is fire-and-forget after submit; give it a moment.
    const waitState = async (id: string, state: string, timeoutMs = 2000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const t = (await getTasks()).find((task) => task.id === id);
        if (t?.state === state) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`waitState(${id}, ${state}) timed out`);
    };

    // ─── T1 is assigned; T2, T3 blocked ────────────────────────────
    await waitState("T1", "assigned");
    let tasks = await getTasks();
    expect(tasks.find((t) => t.id === "T1")!.state).toBe("assigned");
    expect(tasks.find((t) => t.id === "T2")!.state).toBe("blocked");

    // Helper: send an envelope to the private task-server as `agent`.
    const send = async (agent: string, taskId: string | null, body: unknown) => {
      const response = await taskServer.inject({
        method: "POST",
        url: "/messages",
        headers: { authorization: "Bearer task-secret", "content-type": "application/json" },
        payload: envelope(agent, taskId, body),
      });
      return { status: response.statusCode, body: response.json() };
    };

    // ─── Backend T1: fetch @ v1 → commit v1→v2 → done ──────────────
    let r = await send("backend", null, { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, kind: "files" });

    r = await send("backend", "T1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "repoB/src/api/orders.ts", content: "// v2 with cancelOrder\n", based_on: 1 }],
    });
    expect(r.body).toMatchObject({ ok: true, kind: "committed" });

    r = await send("backend", "T1", { kind: "done" });
    expect(r.body).toEqual({ ok: true, kind: "done" });

    // T2 flips to assigned once T1 is done
    await waitState("T2", "assigned");
    tasks = await getTasks();
    expect(tasks.find((t) => t.id === "T1")!.state).toBe("done");

    // ─── Frontend T2 fetch @ v2 (records read version) ─────────────
    r = await send("frontend", null, { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(r.body).toMatchObject({ ok: true, kind: "files" });

    // ─── Mid-run: inject T4 via POST /api/tasks ────────────────────
    const submitT4 = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${publicToken}`, "content-type": "application/json" },
      payload: {
        tasks: [{
          id: "T4",
          owner: "backend",
          depends_on: [],
          writes: ["repoB/src/api/orders.ts"],
          detail: "backend renames order_id to orderId",
        }],
      },
    });
    expect(submitT4.statusCode).toBe(201);
    await waitState("T4", "assigned");

    // ─── Backend T4: fetch @ v2, commit v2→v3, done ────────────────
    r = await send("backend", null, { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(r.body).toMatchObject({ ok: true, kind: "files" });
    r = await send("backend", "T4", {
      kind: "commit",
      reads: [],
      writes: [{ path: "repoB/src/api/orders.ts", content: "// v3 with orderId\n", based_on: 2 }],
    });
    expect(r.body).toMatchObject({ ok: true, kind: "committed" });
    await send("backend", "T4", { kind: "done" });

    // ─── Frontend T2 commit → STALE ────────────────────────────────
    r = await send("frontend", "T2", {
      kind: "commit",
      reads: [{ path: "repoB/src/api/orders.ts", version: 2 }],
      writes: [{ path: "repoA/src/App.tsx", content: "// UI v2\n", based_on: 1 }],
    });
    expect(r.body).toMatchObject({ ok: false, code: "STALE" });
    expect((r.body as { moved: unknown }).moved).toEqual([
      { path: "repoB/src/api/orders.ts", had: 2, now: 3 },
    ]);

    tasks = await getTasks();
    expect(tasks.find((t) => t.id === "T2")!.state).toBe("assigned");
    expect(tasks.find((t) => t.id === "T2")!.strikes).toBe(1);

    // ─── Frontend re-fetch @ v3 + commit → ok ──────────────────────
    r = await send("frontend", null, { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(r.body).toMatchObject({ ok: true, kind: "files" });
    r = await send("frontend", "T2", {
      kind: "commit",
      reads: [{ path: "repoB/src/api/orders.ts", version: 3 }],
      writes: [{ path: "repoA/src/App.tsx", content: "// UI v2 (uses orderId)\n", based_on: 1 }],
    });
    expect(r.body).toMatchObject({ ok: true, kind: "committed" });
    await send("frontend", "T2", { kind: "done" });

    await waitState("T3", "assigned");
    tasks = await getTasks();
    expect(tasks.find((t) => t.id === "T2")!.state).toBe("done");

    // ─── QA T3 ────────────────────────────────────────────────────
    r = await send("qa", null, { kind: "fetch", paths: ["repoA/src/App.tsx", "repoB/src/api/orders.ts"] });
    expect(r.body).toMatchObject({ ok: true, kind: "files" });
    r = await send("qa", "T3", {
      kind: "commit",
      reads: [
        { path: "repoA/src/App.tsx", version: 2 },
        { path: "repoB/src/api/orders.ts", version: 3 },
      ],
      writes: [{ path: "qa/report.md", content: "PASS\nagree on orderId.\n", based_on: null }],
    });
    expect(r.body).toMatchObject({ ok: true, kind: "committed" });
    await send("qa", "T3", { kind: "done" });

    // ─── Final state ──────────────────────────────────────────────
    tasks = await getTasks();
    const stateOf = (id: string) => tasks.find((t) => t.id === id)!.state;
    expect(stateOf("T1")).toBe("done");
    expect(stateOf("T2")).toBe("done");
    expect(stateOf("T3")).toBe("done");
    expect(stateOf("T4")).toBe("done");
  });
});
