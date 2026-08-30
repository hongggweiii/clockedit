import type { InternalTask } from "./task.types.js";

/**
 * PushAdapter is the server → agent transport. The task-server calls
 * `push(task)` when it wants a specific agent to work on a task. Delivery
 * is fire-and-forget from the task-server's perspective; completion is
 * signaled by the router calling back into the coordinator (onCommit / onDone).
 *
 * Transport is WIP — pluggable so the messaging teammate can drop in a real
 * WebSocket / SSE / HTTP-callback implementation later.
 */
export interface PushAdapter {
  push(task: InternalTask): Promise<void>;
}

/**
 * Local dev / test stub. Records what would have been pushed. The `sent`
 * array is exposed so tests can drive the correlation-map by hand.
 */
export class NoopPushAdapter implements PushAdapter {
  public readonly sent: Array<{ taskId: string; ownerId: string }> = [];

  async push(task: InternalTask): Promise<void> {
    if (!task.owner) throw new Error("cannot push a task with no owner");
    this.sent.push({ taskId: task.id, ownerId: task.owner });
  }
}
