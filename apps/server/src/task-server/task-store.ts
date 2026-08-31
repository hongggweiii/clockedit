import type { JsonStore } from "../store.js";
import type { InternalTask } from "./task.types.js";

/** Read-only access to the task records persisted in the shared JsonStore. */
export class TaskStore {
  constructor(private readonly store: JsonStore) {}

  list(): InternalTask[] {
    return this.store.snapshot().tasks as InternalTask[];
  }

  get(id: string): InternalTask | null {
    return this.list().find((task) => task.id === id) ?? null;
  }
}
