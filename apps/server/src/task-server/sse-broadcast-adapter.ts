import type { InternalTask, Task } from "./task.types.js";
import type { PushAdapter } from "./push-adapter.js";
import type { ServerEvent } from "../router/schemas/events.schemas.js";

export type EventListener = (event: ServerEvent) => void;

/**
 * Broadcasts server events to any registered listener (the SSE endpoint,
 * plus an in-process subscriber for the runner). Implements PushAdapter so
 * the Coordinator can push task assignments through the same channel.
 */
export class SseBroadcastAdapter implements PushAdapter {
  private readonly listeners = new Set<EventListener>();

  async push(task: InternalTask): Promise<void> {
    if (!task.owner) throw new Error("cannot push a task with no owner");
    // Send only the wire-safe Task fields; strip server-only metadata
    // (read_versions, assigned_at, timestamps, last_error).
    const wireTask: Task = {
      id: task.id,
      detail: task.detail,
      state: task.state,
      owner: task.owner,
      depends_on: task.depends_on,
      writes: task.writes,
      strikes: task.strikes,
    };
    this.broadcast({ kind: "task_assigned", task: wireTask });
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private broadcast(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are isolated; one bad subscriber can't break others.
      }
    }
  }
}
