import { describe, expect, it, vi } from "vitest";
import { LocalDispatchPushAdapter } from "./push-adapter.js";
import type { InternalTask } from "./task.types.js";

describe("LocalDispatchPushAdapter", () => {
  it("passes the assigned task id into the Agent run", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = new LocalDispatchPushAdapter(() => "task prompt");
    adapter.bind({ sendMessage });
    const task: InternalTask = {
      id: "T1",
      detail: "Change the API",
      owner: "backend",
      depends_on: [],
      writes: ["repoB/src/api/orders.ts"],
      state: "assigned",
      strikes: 0,
      read_versions: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      assigned_at: "2026-01-01T00:00:00.000Z",
      last_error: null,
    };

    await adapter.push(task);

    await expect.poll(() => sendMessage.mock.calls.length).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith("backend", "task prompt", "T1");
  });
});
