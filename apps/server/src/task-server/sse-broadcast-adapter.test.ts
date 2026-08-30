import { describe, expect, it } from "vitest";
import { SseBroadcastAdapter } from "./sse-broadcast-adapter.js";
import type { ServerEvent } from "../router/schemas/events.schemas.js";
import type { InternalTask } from "./task.types.js";

function makeTask(overrides: Partial<InternalTask> = {}): InternalTask {
  return {
    id: "t1",
    detail: "Do the thing",
    state: "assigned",
    owner: "a1",
    depends_on: [],
    writes: ["src/App.tsx"],
    strikes: 0,
    read_versions: { "shared.ts": 3 },   // server-only; must NOT appear in the pushed event
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
    assigned_at: "2026-08-30T00:00:01.000Z",
    last_error: "some earlier failure",   // server-only; must NOT appear either
    ...overrides,
  };
}

describe("SseBroadcastAdapter", () => {
  it("broadcasts a task_assigned event carrying only wire-safe Task fields", async () => {
    const adapter = new SseBroadcastAdapter();
    const received: ServerEvent[] = [];
    adapter.subscribe((event) => received.push(event));

    await adapter.push(makeTask());

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      kind: "task_assigned",
      task: {
        id: "t1",
        detail: "Do the thing",
        state: "assigned",
        owner: "a1",
        depends_on: [],
        writes: ["src/App.tsx"],
        strikes: 0,
      },
    });
    // Verify server-only fields did not leak.
    if (received[0]!.kind === "task_assigned") {
      const task = received[0]!.task as unknown as Record<string, unknown>;
      expect(task.read_versions).toBeUndefined();
      expect(task.assigned_at).toBeUndefined();
      expect(task.last_error).toBeUndefined();
      expect(task.created_at).toBeUndefined();
      expect(task.updated_at).toBeUndefined();
    }
  });

  it("delivers to every subscriber", async () => {
    const adapter = new SseBroadcastAdapter();
    const a: ServerEvent[] = [];
    const b: ServerEvent[] = [];
    adapter.subscribe((e) => a.push(e));
    adapter.subscribe((e) => b.push(e));

    await adapter.push(makeTask({ id: "t2" }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(adapter.listenerCount()).toBe(2);
  });

  it("unsubscribe removes exactly one listener", async () => {
    const adapter = new SseBroadcastAdapter();
    const received: ServerEvent[] = [];
    const unsub = adapter.subscribe((e) => received.push(e));
    unsub();
    await adapter.push(makeTask());
    expect(received).toEqual([]);
    expect(adapter.listenerCount()).toBe(0);
  });

  it("one bad listener doesn't break others", async () => {
    const adapter = new SseBroadcastAdapter();
    const received: ServerEvent[] = [];
    adapter.subscribe(() => {
      throw new Error("bad listener");
    });
    adapter.subscribe((e) => received.push(e));
    await adapter.push(makeTask());
    expect(received).toHaveLength(1);
  });

  it("rejects an owner-less task", async () => {
    const adapter = new SseBroadcastAdapter();
    await expect(adapter.push(makeTask({ owner: null }))).rejects.toThrow(/owner/);
  });
});
