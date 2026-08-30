import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type { Project, Task, TaskState } from "../types.js";

const now = () => new Date().toISOString();

export interface CreateProjectInput {
  name: string;
  workspacePath: string;
  tasks: Array<{
    id?: string | undefined;
    title: string;
    description: string;
    role: string;
    dependsOn?: string[] | undefined;
    intent?: { reads?: string[] | undefined; writes?: string[] | undefined } | undefined;
  }>;
}

export interface CreateProjectResult {
  project: Project;
  tasks: Task[];
}

export class TaskStore {
  constructor(private readonly store: JsonStore) {}

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const projectId = randomUUID();
    const timestamp = now();
    const idAliases = new Map<string, string>();
    for (const t of input.tasks) {
      const stable = t.id ?? randomUUID();
      idAliases.set(t.id ?? stable, stable);
    }
    const project: Project = {
      id: projectId,
      name: input.name,
      workspacePath: input.workspacePath,
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const tasks: Task[] = input.tasks.map((t) => {
      const id = idAliases.get(t.id ?? "")! /* only when caller supplied id */
        ?? randomUUID();
      return {
        id: t.id ?? id,
        projectId,
        title: t.title,
        description: t.description,
        role: t.role,
        dependsOn: (t.dependsOn ?? []).map((d) => idAliases.get(d) ?? d),
        intent: {
          reads: t.intent?.reads ?? [],
          writes: t.intent?.writes ?? [],
        },
        state: "pending",
        attempt: 0,
        assignedAgentId: null,
        runId: null,
        readVersions: null,
        writtenPaths: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
    await this.store.mutate((db) => {
      db.projects.push(project);
      db.tasks.push(...tasks);
    });
    return { project, tasks };
  }

  listTasksByProject(projectId: string): Task[] {
    return this.store.snapshot().tasks.filter((t) => t.projectId === projectId);
  }

  getTask(taskId: string): Task | null {
    return this.store.snapshot().tasks.find((t) => t.id === taskId) ?? null;
  }

  getProject(projectId: string): Project | null {
    return this.store.snapshot().projects.find((p) => p.id === projectId) ?? null;
  }

  async updateTask(taskId: string, patch: Partial<Task>): Promise<Task> {
    return this.store.mutate((db) => {
      const task = db.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      Object.assign(task, patch, { updatedAt: now() });
      return structuredClone(task);
    });
  }

  async setTaskState(taskId: string, state: TaskState, extra?: Partial<Task>): Promise<Task> {
    return this.updateTask(taskId, { ...(extra ?? {}), state });
  }

  async setProjectState(projectId: string, state: Project["state"]): Promise<void> {
    await this.store.mutate((db) => {
      const project = db.projects.find((p) => p.id === projectId);
      if (!project) return;
      project.state = state;
      project.updatedAt = now();
    });
  }
}
