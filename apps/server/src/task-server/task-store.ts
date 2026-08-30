import type { JsonStore } from "../store.js";
import type { InternalTask, NewTask, TaskState } from "./task.types.js";

const now = () => new Date().toISOString();

/**
 * CRUD wrapper for InternalTask records in the JsonStore. All mutations
 * serialize through JsonStore.mutate() so state transitions are safe under
 * concurrent tick()s.
 */
export class TaskStore {
  constructor(private readonly store: JsonStore) {}

  private tasks(): InternalTask[] {
    return this.store.snapshot().tasks as InternalTask[];
  }

  list(): InternalTask[] {
    return this.tasks();
  }

  get(id: string): InternalTask | null {
    return this.tasks().find((t) => t.id === id) ?? null;
  }

  async createMany(newTasks: readonly NewTask[]): Promise<InternalTask[]> {
    const timestamp = now();
    const created: InternalTask[] = newTasks.map((nt) => ({
      ...nt,
      state: (nt.depends_on.length > 0 ? "blocked" : "unassigned") as TaskState,
      strikes: 0,
      read_versions: null,
      created_at: timestamp,
      updated_at: timestamp,
      assigned_at: null,
      last_error: null,
    }));
    await this.store.mutate((db) => {
      (db.tasks as InternalTask[]).push(...created);
    });
    return created;
  }

  async update(id: string, patch: Partial<InternalTask>): Promise<InternalTask> {
    return this.store.mutate((db) => {
      const task = (db.tasks as InternalTask[]).find((t) => t.id === id);
      if (!task) throw new Error(`Task ${id} not found`);
      Object.assign(task, patch, { updated_at: now() });
      return structuredClone(task);
    });
  }

  async setState(id: string, state: TaskState, extra?: Partial<InternalTask>): Promise<InternalTask> {
    return this.update(id, { ...(extra ?? {}), state });
  }
}
