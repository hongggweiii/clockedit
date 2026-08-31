import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { Router } from "./router/router.js";

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

  it("serves router activity with an incremental cursor", async () => {
    const router = new Router({ onFetch: vi.fn().mockResolvedValue([{ path: "a.ts", version: 1, content: "x" }]) });
    router.registerAgent("agent-1", { send: vi.fn() });
    await router.handleMessage({
      msg_id: "5ad35cb4-3863-4c69-94b8-c829fbaa78d3",
      agent: "agent-1",
      task_id: null,
      body: { kind: "fetch", paths: ["a.ts"] },
    });
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, router);
    const all = await app.inject({ method: "GET", url: "/api/events" });
    expect(all.statusCode).toBe(200);
    expect(all.json().events).toHaveLength(2);
    const afterRequest = await app.inject({ method: "GET", url: "/api/events?after=1" });
    expect(afterRequest.json().events).toHaveLength(1);
    await app.close();
  });

});
