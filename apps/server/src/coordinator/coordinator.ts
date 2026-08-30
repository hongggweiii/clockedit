import type { Agent, Task } from "../types.js";
import type { JsonStore } from "../store.js";
import { plan } from "./scheduler.js";
import { evaluateCommit, MAX_ATTEMPTS } from "./occ.js";
import type { AgentPool } from "./agent-pool.js";
import { createAgentPool } from "./agent-pool.js";
import type { VersionStore } from "./version-store.js";
import { TaskStore } from "./task-store.js";
import type { CreateProjectInput, CreateProjectResult } from "./task-store.js";
import { validateDag } from "./dag.js";

export interface TaskExecutionInput {
  task: Task;
  agent: Agent;
  workspacePath: string;
}

export interface TaskExecutionResult {
  runId: string;
  writtenPaths: string[];
  output?: string;
}

export interface TaskExecutor {
  execute(input: TaskExecutionInput): Promise<TaskExecutionResult>;
}

export interface CoordinatorDeps {
  store: JsonStore;
  taskStore: TaskStore;
  versionStore: VersionStore;
  executor: TaskExecutor;
  agentPool?: AgentPool;
}

export class DagRejected extends Error {
  constructor(public readonly reason: unknown) {
    super("DAG validation failed");
  }
}

export class Coordinator {
  private readonly taskStore: TaskStore;
  private readonly versionStore: VersionStore;
  private readonly executor: TaskExecutor;
  private readonly agentPool: AgentPool;
  private readonly store: JsonStore;
  private ticking = false;
  private pendingTick = false;
  private readonly listeners = new Set<(event: CoordinatorEvent) => void>();

  constructor(deps: CoordinatorDeps) {
    this.store = deps.store;
    this.taskStore = deps.taskStore;
    this.versionStore = deps.versionStore;
    this.executor = deps.executor;
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
        // listener errors do not propagate
      }
    }
  }

  async submitProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const validation = validateDag(
      input.tasks.map((t, index) => ({ id: t.id ?? `__i${index}`, dependsOn: t.dependsOn ?? [] })),
    );
    if (!validation.ok) {
      throw new DagRejected(validation.errors);
    }
    const roles = new Set(input.tasks.map((t) => t.role));
    for (const role of roles) {
      if (!this.agentPool.hasRole(role)) {
        throw new DagRejected([{ kind: "missing-role", role }]);
      }
    }
    const result = await this.taskStore.createProject(input);
    void this.tick();
    return result;
  }

  async unfreezeTask(taskId: string): Promise<void> {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state !== "frozen") throw new Error(`Task ${taskId} is not frozen`);
    await this.taskStore.setTaskState(taskId, "pending", { attempt: 0, lastError: null });
    void this.tick();
  }

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
    const snapshot = this.store.snapshot();
    const projectIds = new Set(snapshot.projects.filter((p) => p.state === "active").map((p) => p.id));
    const activeTasks = snapshot.tasks.filter((t) => projectIds.has(t.projectId));
    const schedulerPlan = plan(activeTasks, this.agentPool);

    for (const taskId of schedulerPlan.markReady) {
      await this.taskStore.setTaskState(taskId, "ready");
      this.emit({ type: "state-changed", taskId, state: "ready" });
    }

    // Snapshot post-mutation state before dispatching (readVersions).
    for (const decision of schedulerPlan.dispatch) {
      const task = this.taskStore.getTask(decision.taskId);
      if (!task || (task.state !== "ready" && task.state !== "pending")) continue;
      const project = this.taskStore.getProject(task.projectId);
      if (!project) continue;
      const readVersions = await this.versionStore.head(project.id, task.intent.reads);
      await this.taskStore.updateTask(task.id, {
        state: "dispatched",
        assignedAgentId: decision.agent.id,
        readVersions,
      });
      this.emit({ type: "dispatched", taskId: task.id, agentId: decision.agent.id });
      void this.runTask(task.id, decision.agent, project.workspacePath);
    }

    // Check for project terminal state
    await this.maybeFinalizeProjects(projectIds);
  }

  private async runTask(taskId: string, agent: Agent, workspacePath: string): Promise<void> {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    await this.taskStore.setTaskState(taskId, "running");
    let execution: TaskExecutionResult;
    try {
      execution = await this.executor.execute({ task, agent, workspacePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskStore.setTaskState(taskId, "failed", { lastError: message });
      this.emit({ type: "failed", taskId, error: message });
      void this.tick();
      return;
    }
    await this.taskStore.setTaskState(taskId, "committing", {
      runId: execution.runId,
      writtenPaths: execution.writtenPaths,
    });
    const post = this.taskStore.getTask(taskId);
    if (!post) return;
    const outcome = await evaluateCommit({
      task: post,
      writtenPaths: execution.writtenPaths,
      versionStore: this.versionStore,
    });
    if (outcome.kind === "committed") {
      await this.taskStore.setTaskState(taskId, "completed", { lastError: null });
      this.emit({ type: "committed", taskId, newVersions: outcome.newVersions });
    } else if (outcome.kind === "retry") {
      await this.taskStore.setTaskState(taskId, "pending", {
        attempt: outcome.attempt,
        assignedAgentId: null,
        readVersions: null,
        lastError: `OCC conflict on: ${outcome.conflictedPaths.join(", ")}`,
      });
      this.emit({ type: "conflict-retry", taskId, attempt: outcome.attempt, conflictedPaths: outcome.conflictedPaths });
    } else {
      await this.taskStore.setTaskState(taskId, "frozen", {
        attempt: outcome.attempt,
        lastError: `Frozen after ${MAX_ATTEMPTS} attempts. Conflicts on: ${outcome.conflictedPaths.join(", ")}`,
      });
      this.emit({ type: "frozen", taskId, attempt: outcome.attempt, conflictedPaths: outcome.conflictedPaths });
    }
    void this.tick();
  }

  private async maybeFinalizeProjects(projectIds: ReadonlySet<string>): Promise<void> {
    const snapshot = this.store.snapshot();
    for (const projectId of projectIds) {
      const tasks = snapshot.tasks.filter((t) => t.projectId === projectId);
      if (tasks.length === 0) continue;
      const hasFrozen = tasks.some((t) => t.state === "frozen");
      const allTerminal = tasks.every((t) => ["completed", "frozen", "failed"].includes(t.state));
      if (!allTerminal) continue;
      const next = hasFrozen ? "frozen" : "completed";
      await this.taskStore.setProjectState(projectId, next);
      this.emit({ type: "project-finalized", projectId, state: next });
    }
  }
}

export type CoordinatorEvent =
  | { type: "state-changed"; taskId: string; state: Task["state"] }
  | { type: "dispatched"; taskId: string; agentId: string }
  | { type: "committed"; taskId: string; newVersions: Record<string, string> }
  | { type: "conflict-retry"; taskId: string; attempt: number; conflictedPaths: string[] }
  | { type: "frozen"; taskId: string; attempt: number; conflictedPaths: string[] }
  | { type: "failed"; taskId: string; error: string }
  | { type: "project-finalized"; projectId: string; state: "completed" | "frozen" };
