import type { InternalTask } from "./task.types.js";

/**
 * PushAdapter is the server → agent transport for task assignments. The
 * Coordinator calls `push(task)` when it wants an owner agent to start work.
 * Delivery is fire-and-forget from the Coordinator's perspective; completion
 * flows back via `Router.onCommit` / `onDone` when the agent responds.
 */
export interface PushAdapter {
  push(task: InternalTask): Promise<void>;
}

/**
 * Test / dev stub. Records what would have been pushed. The `sent` array is
 * exposed so unit tests can assert dispatch decisions without spawning Codex.
 */
export class NoopPushAdapter implements PushAdapter {
  public readonly sent: Array<{ taskId: string; ownerId: string }> = [];

  async push(task: InternalTask): Promise<void> {
    if (!task.owner) throw new Error("cannot push a task with no owner");
    this.sent.push({ taskId: task.id, ownerId: task.owner });
  }
}

/**
 * Real dispatch adapter for the local hackathon flow. When the Coordinator
 * assigns a task to an owner, spawn Codex for that owner with a task-derived
 * prompt via AgentService.sendMessage. Codex then uses agentctl to fetch,
 * mark-edited, commit, and done.
 *
 * `sendMessage` returns after the run is queued, so awaiting it verifies that
 * the assignment was accepted without waiting for the LLM run to finish.
 */
export interface AgentDispatcher {
  sendMessage(agentId: string, prompt: string, taskId?: string): Promise<unknown>;
}

export class LocalDispatchPushAdapter implements PushAdapter {
  private dispatcher: AgentDispatcher | null = null;

  constructor(private readonly buildPrompt: (task: InternalTask) => string = defaultTaskPrompt) {}

  /** Set the dispatcher once it's available (breaks the coordinator ↔ service init cycle). */
  bind(dispatcher: AgentDispatcher): void {
    this.dispatcher = dispatcher;
  }

  async push(task: InternalTask): Promise<void> {
    if (!task.owner) throw new Error("cannot push a task with no owner");
    const dispatcher = this.dispatcher;
    if (!dispatcher) {
      console.error(`[dispatch] task=${task.id}: no dispatcher bound; assignment goes unheard`);
      return;
    }
    const prompt = this.buildPrompt(task);
    await dispatcher.sendMessage(task.owner, prompt, task.id);
  }
}

function defaultTaskPrompt(task: InternalTask): string {
  const writes = task.writes.length > 0
    ? `\nExpected to write: ${task.writes.join(", ")}`
    : "";
  const deps = task.depends_on.length > 0
    ? `\nUpstream tasks (already done): ${task.depends_on.join(", ")}`
    : "";
  return [
    `You have been assigned task ${task.id}.`,
    "",
    task.detail,
    writes,
    deps,
    "",
    "Use agentctl to fetch files, mark-edited, commit, and done.",
  ].filter(Boolean).join("\n");
}
