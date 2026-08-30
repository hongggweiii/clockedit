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
    const coordinator = { fetch: vi.fn().mockResolvedValue([
      { path: "a.ts", version: 1, content: "x" },
      { path: "b.ts", version: 2, content: "y" },
    ]), commit: vi.fn(), done: vi.fn() };
    const router = new Router(coordinator);
    await expect(router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts"] }))).rejects.toThrow("not registered");
    router.registerAgent("agent-1", { send: vi.fn() });
    await expect(router.handleMessage(envelope({ kind: "fetch", paths: ["a.ts", "b.ts"] }))).resolves.toEqual({ ok: true, kind: "files", files: [
      { path: "a.ts", version: 1, content: "x" },
      { path: "b.ts", version: 2, content: "y" },
    ] });
    expect(coordinator.fetch).toHaveBeenCalledWith("agent-1", { kind: "fetch", paths: ["a.ts", "b.ts"] });
  });

  it("acknowledges a successful done request", async () => {
    const done = vi.fn().mockResolvedValue(undefined);
    const router = new Router({ fetch: vi.fn(), commit: vi.fn(), done });
    router.registerAgent("agent-1", { send: vi.fn() });
    await expect(router.handleMessage(envelope({ kind: "done" }, "task-1"))).resolves.toEqual({ ok: true, kind: "done" });
    expect(done).toHaveBeenCalledWith("agent-1", "task-1", { kind: "done" });
  });

  it("dispatches schema-valid responses through the registered channel", async () => {
    const send = vi.fn();
    const router = new Router({ fetch: vi.fn(), commit: vi.fn(), done: vi.fn() });
    router.registerAgent("agent-1", { send });
    await router.dispatch("agent-1", { ok: true, kind: "committed" });
    expect(send).toHaveBeenCalledWith({ ok: true, kind: "committed" });
  });
});
