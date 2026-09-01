import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { Router } from "../router/router.js";
import { createTaskServerApp } from "../task-server/app.js";
import type { FastifyInstance } from "fastify";
import type { AgentProfile, Response as ProtocolResponse } from "../types.js";

/**
 * Per-agent SSE isolation, at the private HTTP boundary.
 *
 * Focuses on the /events?agent_id=X endpoint (Kelly's design):
 *  - auth boundary (401, 400, 404)
 *  - duplicate connection is rejected (409)
 *  - two concurrent real fetch() SSE clients — dispatching to A does not
 *    leak into B
 *
 * Doesn't run the DAG; bypass AgentService's loopback so tests can hold the
 * SSE stream directly and observe frames.
 */
describe("Demo scenario 1 — SSE per-agent isolation", () => {
  let root: string;
  let taskServer: FastifyInstance;
  let baseUrl: string;
  let router: Router;
  const bearerHeader = { authorization: "Bearer sse-token" };
  const profiles = new Map<string, AgentProfile>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "scenario1-sse-"));
    profiles.clear();
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      TASK_SERVER_AUTH_TOKEN: "sse-token",
    });
    router = new Router({
      listFiles: vi.fn(),
      onFetch: vi.fn(),
      onCommit: vi.fn(),
      onDone: vi.fn(),
    });
    taskServer = await createTaskServerApp(config, router, (agentId) => profiles.get(agentId) ?? null);
    await taskServer.listen({ host: "127.0.0.1", port: 0 });
    const address = taskServer.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await taskServer.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects /events without bearer (401)", async () => {
    const response = await fetch(`${baseUrl}/events?agent_id=backend`);
    expect(response.status).toBe(401);
  });

  it("rejects /events without agent_id (400)", async () => {
    const response = await fetch(`${baseUrl}/events`, { headers: bearerHeader });
    expect(response.status).toBe(400);
  });

  it("rejects /events for an unknown agent (404)", async () => {
    const response = await fetch(`${baseUrl}/events?agent_id=ghost`, { headers: bearerHeader });
    expect(response.status).toBe(404);
  });

  it("rejects a duplicate SSE connection for the same agent (409)", async () => {
    profiles.set("backend", { id: "backend", description: "" });
    // Open the first connection; hold it open with an AbortController.
    const controller = new AbortController();
    const first = await fetch(`${baseUrl}/events?agent_id=backend`, {
      headers: bearerHeader,
      signal: controller.signal,
    });
    expect(first.status).toBe(200);

    // Give the server a beat to register the channel.
    await new Promise((r) => setTimeout(r, 50));

    const second = await fetch(`${baseUrl}/events?agent_id=backend`, { headers: bearerHeader });
    expect(second.status).toBe(409);

    controller.abort();
    await first.body?.cancel().catch(() => undefined);
  });

  it("dispatches only to the targeted agent's SSE stream (no cross-talk)", async () => {
    profiles.set("backend", { id: "backend", description: "" });
    profiles.set("frontend", { id: "frontend", description: "" });

    const backendCtrl = new AbortController();
    const frontendCtrl = new AbortController();
    const backendResponse = await fetch(`${baseUrl}/events?agent_id=backend`, {
      headers: bearerHeader, signal: backendCtrl.signal,
    });
    const frontendResponse = await fetch(`${baseUrl}/events?agent_id=frontend`, {
      headers: bearerHeader, signal: frontendCtrl.signal,
    });
    expect(backendResponse.status).toBe(200);
    expect(frontendResponse.status).toBe(200);

    // Consume until we see one full SSE data frame or the stream ends.
    const collectOne = async (response: Response, matcher: RegExp, budgetMs = 500): Promise<string | null> => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const start = Date.now();
      let buffer = "";
      while (Date.now() - start < budgetMs) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), budgetMs - (Date.now() - start)),
          ),
        ]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (matcher.test(buffer)) {
          reader.releaseLock();
          return buffer;
        }
      }
      reader.releaseLock();
      return matcher.test(buffer) ? buffer : null;
    };

    // Wait for both SSE connections to be fully registered on the server side.
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch to backend ONLY.
    const payload: ProtocolResponse = { ok: true, kind: "done" } as ProtocolResponse;
    await router.dispatch("backend", payload);

    // Backend should receive the frame; frontend should not.
    const backendFrame = await collectOne(backendResponse, /"kind":"done"/);
    expect(backendFrame).not.toBeNull();

    const frontendFrame = await collectOne(frontendResponse, /"kind":"done"/, 200);
    expect(frontendFrame).toBeNull();

    backendCtrl.abort();
    frontendCtrl.abort();
    await backendResponse.body?.cancel().catch(() => undefined);
    await frontendResponse.body?.cancel().catch(() => undefined);
  });
});
