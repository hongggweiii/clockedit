import type { JsonStore } from "../store.js";
import type { CommitRequest, CreateTasksRequest, DoneRequest, FetchRequest } from "../router/router.types.js";
import { validateDag } from "./dag.js";
import { plan } from "./scheduler.js";
import { evaluateCommit, MAX_STRIKES } from "./occ.js";
import type { AgentPool } from "./agent-pool.js";
import { createAgentPool } from "./agent-pool.js";
import type { FileStore } from "./version-store.js";
import { TaskStore } from "./task-store.js";
import type { PushAdapter } from "./push-adapter.js";
import type { InternalTask, NewTask, TaskState } from "./task.types.js";

export class DagRejected extends Error {
  constructor(public readonly reason: unknown) {
    super("DAG validation failed");
  }
}

export class UnknownTask extends Error {
  constructor(public readonly taskId: string) {
    super(`Unknown task: ${taskId}`);
  }
}

export interface CoordinatorDeps {
  store: JsonStore;
  taskStore: TaskStore;
  fileStore: FileStore;
  pushAdapter: PushAdapter;
  agentPool?: AgentPool;
}

/**
 * TaskCommitResult mirrors the router's response shape. The router validates
 * envelopes; my callbacks return the semantic result.
 */
export type TaskCommitResult =
  | { ok: true; kind: "committed"; newVersions: Record<string, number> }
  | { ok: false; kind: "stale"; conflictedPaths: string[] };

/**
 * The task-server:
 *  - owns the DAG + state machine
 *  - dispatches to agents by pushing over PushAdapter
 *  - exposes callback hooks (onCommit / onFetch / onDone / onCreateTasks)
 *    that the router invokes when validated agent messages arrive
 */
export class Coordinator {
  private readonly store: JsonStore;
  private readonly taskStore: TaskStore;
  private readonly fileStore: FileStore;
  private readonly pushAdapter: PushAdapter;
  private readonly agentPool: AgentPool;
  private ticking = false;
  private pendingTick = false;
  private readonly listeners = new Set<(event: CoordinatorEvent) => void>();

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.taskStore = deps.taskStore;
    this.fileStore = deps.fileStore;
    this.pushAdapter = deps.pushAdapter;
    this.agentPool = deps.agentPool ?? createAgentPool(() => this.store.snapshot().agents);
  }

  on(listener: (event: CoordinatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CoordinatorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors don't propagate
      }
    }
  }

  /** Submit an initial DAG. Validates cycles + owner existence before persisting. */
  async submitTasks(tasks: readonly NewTask[]): Promise<InternalTask[]> {
    const existingIds = new Set(this.taskStore.list().map((t) => t.id));
    const validation = validateDag(tasks, existingIds);
    if (!validation.ok) throw new DagRejected(validation.errors);
    for (const t of tasks) {
      if (t.owner && !this.agentPool.exists(t.owner)) {
        throw new DagRejected([{ kind: "unknown-owner", taskId: t.id, owner: t.owner }]);
      }
    }
    const created = await this.taskStore.createMany(tasks);
    void this.tick();
    return created;
  }

  /** Reentrant scheduler kick. Safe to call from anywhere. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.pendingTick = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.pendingTick = false;
        await this.tickOnce();
      } while (this.pendingTick);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const tasks = this.taskStore.list();
    const schedulerPlan = plan(tasks, this.agentPool);

    for (const taskId of schedulerPlan.markUnassigned) {
      await this.taskStore.setState(taskId, "unassigned");
      this.emit({ type: "state-changed", taskId, state: "unassigned" });
    }

    for (const decision of schedulerPlan.dispatch) {
      const task = this.taskStore.get(decision.taskId);
      if (!task || task.state !== "unassigned") continue;
      const assigned = await this.taskStore.update(task.id, {
        state: "assigned",
        assigned_at: new Date().toISOString(),
      });
      this.emit({ type: "dispatched", taskId: task.id, ownerId: decision.ownerId });
      try {
        await this.pushAdapter.push(assigned);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.taskStore.setState(task.id, "unassigned", {
          assigned_at: null,
          last_error: `push failed: ${message}`,
        });
        this.emit({ type: "push-failed", taskId: task.id, error: message });
      }
    }
  }

  // ─── Router callbacks ────────────────────────────────────────────

  /**
   * Called by the router when an agent's `fetch` message is validated.
   * Returns file contents + head versions. Read-version tracking (which
   * versions the agent SAW) is currently the router/file-store teammate's
   * responsibility — this handler is a thin passthrough.
   */
  async onFetch(_agentId: string, request: FetchRequest): Promise<Array<{ path: string; version: number; content: string }>> {
    return this.fileStore.fetch(request.paths);
  }

  /**
   * Called by the router when an agent's `commit` message is validated.
   * Runs OCC against FileStore; on success advances the task toward `done`.
   * On conflict, either resets the task to unassigned (retry) or escalates
   * after MAX_STRIKES.
   *
   * Note: task state transition to `done` happens only after both `commit`
   * AND `done` are received. This handler leaves the task in `assigned`
   * on success — waiting for `done` to close it.
   */
  async onCommit(agentId: string, taskId: string, request: CommitRequest): Promise<TaskCommitResult> {
    const task = this.taskStore.get(taskId);
    if (!task) throw new UnknownTask(taskId);
    if (task.state !== "assigned") {
      throw new Error(`Task ${taskId} not currently assigned (state=${task.state})`);
    }
    if (task.owner !== agentId) {
      throw new Error(`Agent ${agentId} is not the owner of task ${taskId}`);
    }

    const outcome = await evaluateCommit({
      task,
      agentId,
      reads: request.reads,
      writes: request.writes,
      fileStore: this.fileStore,
    });

    if (outcome.kind === "committed") {
      // Do not transition to done yet — wait for the explicit `done` message.
      // Just record the successful commit; state stays `assigned`.
      this.emit({ type: "committed", taskId, newVersions: outcome.newVersions });
      return { ok: true, kind: "committed", newVersions: outcome.newVersions };
    }

    if (outcome.kind === "retry") {
      await this.taskStore.update(taskId, {
        state: "unassigned",
        strikes: outcome.strikes,
        assigned_at: null,
        read_versions: null,
        last_error: `OCC conflict on: ${outcome.conflictedPaths.join(", ")}`,
      });
      this.emit({ type: "conflict-retry", taskId, strikes: outcome.strikes, conflictedPaths: outcome.conflictedPaths });
      void this.tick();
      return { ok: false, kind: "stale", conflictedPaths: outcome.conflictedPaths };
    }

    // exhausted → escalated
    await this.taskStore.setState(taskId, "escalated", {
      strikes: outcome.strikes,
      last_error: `Escalated after ${MAX_STRIKES} strikes. Conflicts on: ${outcome.conflictedPaths.join(", ")}`,
    });
    this.emit({ type: "escalated", taskId, strikes: outcome.strikes, conflictedPaths: outcome.conflictedPaths });
    void this.tick();
    return { ok: false, kind: "stale", conflictedPaths: outcome.conflictedPaths };
  }

  /**
   * Called by the router when an agent's `done` message is validated.
   * Marks the task as done and re-ticks so downstream deps unblock.
   */
  async onDone(agentId: string, taskId: string, _request: DoneRequest): Promise<void> {
    const task = this.taskStore.get(taskId);
    if (!task) throw new UnknownTask(taskId);
    if (task.state !== "assigned") {
      throw new Error(`Task ${taskId} cannot be done (state=${task.state})`);
    }
    if (task.owner !== agentId) {
      throw new Error(`Agent ${agentId} is not the owner of task ${taskId}`);
    }
    await this.taskStore.setState(taskId, "done", { last_error: null });
    this.emit({ type: "done", taskId });
    void this.tick();
  }

  /**
   * Called by the router when an agent's `create_tasks` message is
   * validated. Appends the proposed tasks to the DAG after DAG-level
   * validation (cycles, unknown deps, unknown owners).
   */
  async onCreateTasks(_agentId: string, request: CreateTasksRequest): Promise<InternalTask[]> {
    return this.submitTasks(request.tasks);
  }
}

// ─── Events (for observability / UI) ────────────────────────────────

export type CoordinatorEvent =
  | { type: "state-changed"; taskId: string; state: TaskState }
  | { type: "dispatched"; taskId: string; ownerId: string }
  | { type: "committed"; taskId: string; newVersions: Record<string, number> }
  | { type: "conflict-retry"; taskId: string; strikes: number; conflictedPaths: string[] }
  | { type: "escalated"; taskId: string; strikes: number; conflictedPaths: string[] }
  | { type: "done"; taskId: string }
  | { type: "push-failed"; taskId: string; error: string };
