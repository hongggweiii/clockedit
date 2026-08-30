import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { CoordinationMessageHandler } from "./router/coordination-handler.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("validates and forwards coordination messages with project context", async () => {
    const received: Array<{ projectId: string; kind: string }> = [];
    const handler: CoordinationMessageHandler = {
      handleMessage(projectId, envelope) {
        received.push({ projectId, kind: envelope.body.kind });
        return {
          ok: true,
          kind: "file",
          path: "src/App.tsx",
          version: 3,
          content: "export {};",
        };
      },
    };
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, handler);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/coordination/messages",
      payload: {
        msg_id: "5ad35cb4-3863-4c69-94b8-c829fbaa78d3",
        agent: "frontend",
        task_id: "task-1",
        body: { kind: "fetch", paths: ["src/App.tsx"] },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, kind: "file", version: 3 });
    expect(received).toEqual([{ projectId: "project-1", kind: "fetch" }]);
    await app.close();
  });

  it("returns 400 instead of leaking malformed coordination errors", async () => {
    let handled = false;
    const handler: CoordinationMessageHandler = {
      handleMessage() {
        handled = true;
        return { ok: true, kind: "committed" };
      },
    };
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, handler);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/coordination/messages",
      payload: {
        msg_id: "not-a-uuid",
        agent: "frontend",
        task_id: null,
        body: { kind: "fetch", path: "src/App.tsx" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
    expect(handled).toBe(false);
    await app.close();
  });

  it("reports when the coordination handler has not been connected", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/coordination/messages",
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
