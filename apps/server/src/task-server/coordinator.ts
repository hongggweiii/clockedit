import type { JsonStore } from "../store.js";
import type {
  CommitRequest,
  CreateTasksRequest,
  DoneRequest,
  FetchRequest,
  ListFilesRequest,
  Response,
} from "../router/router.types.js";
import type { RouterCoordinator } from "../router/router.js";
import type { FileStore } from "../storage/file-store.js";
import { validateDag } from "./dag.js";
import { plan } from "./scheduler.js";
import { evaluateCommit, MAX_STRIKES } from "./occ.js";
import type { AgentPool } from "./agent-pool.js";
import { createAgentPool } from "./agent-pool.js";
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
 * The Coordinator: brain of the task-server.
 *
 *  - Owns the DAG + state machine (task-store).
 *  - Dispatches ready tasks to their owner agent via PushAdapter.
 *  - Implements RouterCoordinator so the Router can hand it validated
 *    agent messages (fetch / commit / done / createTasks / listFiles).
 *
 * OCC failure handling is "immediate-retry": on a stale commit the task
 * stays `assigned` (same owner) with strikes++ and the agent gets a STALE
 * response to re-fetch and try again. Bounded by MAX_STRIKES = 3; on the
 * 3rd conflict the task is dropped (state → "dropped"), the agent gets
 * a terminal STALE response, and the coordinator ticks so downstream
 * tasks whose deps included this one stay blocked.
 */
export class Coordinator implements RouterCoordinator {
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

  /** Read all persisted tasks (for public polling / UI). */
  listTasks(): InternalTask[] {
    return this.taskStore.list();
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

  // ─── RouterCoordinator implementation ──────────────────────────────
  //
  // These methods are invoked by the Router with pre-validated payloads.
  // Method names + signatures must match RouterCoordinator in router.ts.

  async listFiles(_agentId: string, _request: ListFilesRequest): Promise<Array<{ path: string; version: number }>> {
    return this.fileStore.list();
  }

  async onFetch(agentId: string, request: FetchRequest): Promise<Array<{ path: string; version: number; content: string }>> {
    // The Router decides how to handle missing paths (all-or-nothing NOT_FOUND).
    // We just return the files we found, in the order we successfully fetched them.
    const found: Array<{ path: string; version: number; content: string }> = [];
    for (const path of request.paths) {
      const result = await this.fileStore.fetch(agentId, path);
      if (result.ok) {
        found.push({ path: result.path, version: result.version, content: result.content });
      }
    }
    return found;
  }

  /**
   * Handle an agent's commit. Returns the Response the router will forward
   * to the agent. Immediate-retry semantics: on STALE the task stays
   * `assigned` and the agent re-fetches; on MAX_STRIKES the task is dropped.
   *
   * Note: task state transitions to `done` only after an explicit `done`
   * message — the commit response leaves the task in `assigned`.
   */
  async onCommit(agentId: string, taskId: string, request: CommitRequest): Promise<Response> {
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
      this.emit({ type: "committed", taskId, versions: outcome.versions });
      // Include new_versions so the agent can refresh its local view without a re-fetch.
      return { ok: true, kind: "committed", new_versions: outcome.versions };
    }

    if (outcome.kind === "retry") {
      // Keep the task assigned; just record the strike. Agent will re-fetch
      // and re-submit. No re-queue, no re-dispatch.
      await this.taskStore.update(taskId, {
        strikes: outcome.strikes,
        last_error: `OCC conflict; ${outcome.moved.length} path(s) moved`,
      });
      this.emit({ type: "conflict-retry", taskId, strikes: outcome.strikes, moved: outcome.moved });
      return { ok: false, code: "STALE", moved: outcome.moved };
    }

    // exhausted → task is dropped (terminal, no more work).
    await this.taskStore.setState(taskId, "dropped", {
      strikes: outcome.strikes,
      last_error: `Dropped after ${MAX_STRIKES} strikes; ${outcome.moved.length} path(s) moved`,
    });
    this.emit({ type: "dropped", taskId, strikes: outcome.strikes, moved: outcome.moved });
    void this.tick();
    return { ok: false, code: "STALE", moved: outcome.moved };
  }

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

  async onCreateTasks(_agentId: string, request: CreateTasksRequest): Promise<Array<{ id: string }>> {
    const created = await this.submitTasks(request.tasks);
    return created.map((task) => ({ id: task.id }));
  }
}

// ─── Events (for observability / UI) ────────────────────────────────

export type CoordinatorEvent =
  | { type: "state-changed"; taskId: string; state: TaskState }
  | { type: "dispatched"; taskId: string; ownerId: string }
  | { type: "committed"; taskId: string; versions: Record<string, number> }
  | { type: "conflict-retry"; taskId: string; strikes: number; moved: Array<{ path: string; had: number; now: number }> }
  | { type: "dropped"; taskId: string; strikes: number; moved: Array<{ path: string; had: number; now: number }> }
  | { type: "done"; taskId: string }
  | { type: "push-failed"; taskId: string; error: string };
