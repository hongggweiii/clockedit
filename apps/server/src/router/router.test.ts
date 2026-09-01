import { describe, expect, it, vi } from "vitest";
import { Router } from "./router.js";

const envelope = (body: unknown, task_id: string | null = null) => ({
  msg_id: "5ad35cb4-3863-4c69-94b8-c829fbaa78d3",
  agent: "agent-1",
  task_id,
  body,
});

describe("Router", () => {
  it("requires registration and routes validated fetches", async () => {
    const coordinator = {
      onFetch: vi.fn().mockResolvedValue([
        { path: "a.ts", version: 1, content: "x" },
        { path: "b.ts", version: 2, content: "y" },
      ]),
      onCommit: vi.fn(),
      onDone: vi.fn(),
    };
    const router = new Router(coordinator);
    await expect(router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts"] }))).rejects.toThrow("not registered");
    router.registerAgent("agent-1", { send: vi.fn() });
    await expect(router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts", "b.ts"] }))).resolves.toEqual({
      ok: true,
      kind: "files",
      files: [
        { path: "a.ts", version: 1, content: "x" },
        { path: "b.ts", version: 2, content: "y" },
      ],
    });
    expect(coordinator.onFetch).toHaveBeenCalledWith("agent-1", { kind: "fetch", paths: ["a.ts", "b.ts"] });
  });

  it("acknowledges a successful done request", async () => {
    const done = vi.fn().mockResolvedValue(undefined);
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: done });
    router.registerAgent("agent-1", { send: vi.fn() });
    await expect(router.handleMessage(envelope({ kind: "done" }, "task-1"))).resolves.toEqual({ ok: true, kind: "done" });
    expect(done).toHaveBeenCalledWith("agent-1", "task-1", { kind: "done" });
  });

  it("lists registered agent profiles", async () => {
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    router.registerAgent("agent-1", { send: vi.fn() }, { description: "Builds the frontend" });
    router.registerAgent("agent-2", { send: vi.fn() });

    await expect(router.handleMessage(envelope({ kind: "list_agents" }))).resolves.toEqual({
      ok: true,
      kind: "agent_profiles",
      agents: [
        { id: "agent-1", description: "Builds the frontend" },
        { id: "agent-2", description: "" },
      ],
    });
  });

  it("updates a registered agent description", async () => {
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    router.registerAgent("agent-1", { send: vi.fn() }, { description: "Old" });
    router.updateAgentProfile("agent-1", { description: "New" });

    await expect(router.handleMessage(envelope({ kind: "list_agents" }))).resolves.toEqual({
      ok: true,
      kind: "agent_profiles",
      agents: [{ id: "agent-1", description: "New" }],
    });
  });

  it("dispatches schema-valid responses through the registered channel", async () => {
    const send = vi.fn();
    const router = new Router({ onFetch: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() });
    router.registerAgent("agent-1", { send });
    await router.dispatch("agent-1", { ok: true, kind: "committed" });
    expect(send).toHaveBeenCalledWith({ ok: true, kind: "committed" });
  });

  it("emits each handled request and response in order", async () => {
    const router = new Router({ onFetch: vi.fn().mockResolvedValue([{ path: "a.ts", version: 1, content: "x" }]) });
    router.registerAgent("agent-1", { send: vi.fn() });

    await router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts"] }));

    const events = router.getEvents();
    expect(events.map((event) => event.type)).toEqual(["request", "response"]);
    expect(events[0]?.payload).toMatchObject({ body: { kind: "fetch" } });
    expect(events[1]?.payload).toMatchObject({ kind: "files" });
    expect(router.getEvents()).toEqual(events);
  });

  it("emits a failed request as an error event", async () => {
    const router = new Router({ onFetch: vi.fn().mockRejectedValue(new Error("backend unavailable")) });
    router.registerAgent("agent-1", { send: vi.fn() });

    await expect(router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts"] }))).rejects.toThrow("backend unavailable");
    expect(router.getEvents().at(-1)).toMatchObject({ type: "error", error: "backend unavailable" });
  });

});
