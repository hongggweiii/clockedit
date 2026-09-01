import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { Router } from "../router/router.js";
import { createTaskServerApp } from "./app.js";
import { SseBroadcastAdapter } from "./sse-broadcast-adapter.js";
import type { AddressInfo } from "node:net";

describe("private task-server HTTP boundary", () => {
  it("does not expose messages without the server token", async () => {
    const router = new Router({ listTasks: async () => [], onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    const app = await createTaskServerApp(
      loadConfig({ NODE_ENV: "test", TASK_SERVER_AUTH_TOKEN: "task-secret" }),
      router,
    );

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/messages", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/messages",
      headers: { authorization: "Bearer task-secret" },
      payload: {},
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET",
      url: "/tasks",
      headers: { authorization: "Bearer task-secret" },
    })).json()).toEqual({ tasks: [] });
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);
    await app.close();
  });

});

describe("private task-server /events (SSE)", () => {
  const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
  const broadcaster = new SseBroadcastAdapter();
  let app: Awaited<ReturnType<typeof createTaskServerApp>>;
  let baseUrl = "";

  beforeAll(async () => {
    app = await createTaskServerApp(
      loadConfig({ NODE_ENV: "test", TASK_SERVER_AUTH_TOKEN: "task-secret" }),
      router,
      broadcaster,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires bearer auth on /events", async () => {
    const response = await fetch(`${baseUrl}/events`);
    expect(response.status).toBe(401);
  });

  it("streams a task_assigned event when the adapter pushes", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/events`, {
      headers: { authorization: "Bearer task-secret" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const readerPromise = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("event: task_assigned")) return buffer;
      }
      return buffer;
    })();

    // Wait for the SSE subscription to register before pushing.
    await new Promise((r) => setTimeout(r, 50));
    await broadcaster.push({
      id: "sse-t1",
      detail: "test push",
      state: "assigned",
      owner: "agent-a",
      depends_on: [],
      writes: [],
      strikes: 0,
      read_versions: null,
      created_at: "",
      updated_at: "",
      assigned_at: null,
      last_error: null,
    });

    const buffer = await Promise.race([
      readerPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2000)),
    ]);
    expect(buffer).toContain("event: task_assigned");
    expect(buffer).toContain(`"id":"sse-t1"`);
    expect(buffer).toContain(`"owner":"agent-a"`);
    // Server-only fields must not leak.
    expect(buffer).not.toContain("read_versions");
    expect(buffer).not.toContain("assigned_at");

    controller.abort();
  });
});
