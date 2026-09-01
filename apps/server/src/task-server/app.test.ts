import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { Router } from "../router/router.js";
import { createTaskServerApp } from "./app.js";

describe("private task-server HTTP boundary", () => {
  it("does not expose messages without the server token", async () => {
    const router = new Router({ listTasks: async () => [], onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    const app = await createTaskServerApp(
      loadConfig({ NODE_ENV: "test", TASK_SERVER_AUTH_TOKEN: "task-secret" }),
      router,
      () => null,
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
