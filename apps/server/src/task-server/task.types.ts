import type { z } from "zod";
import { newTaskSchema, taskSchema, taskStateSchema } from "../router/schemas/task.schemas.js";

export type TaskState = z.infer<typeof taskStateSchema>;
export type Task = z.infer<typeof taskSchema>;
export type NewTask = z.infer<typeof newTaskSchema>;

// Server-side persisted view: shared Task shape plus runtime metadata
// only the task-server tracks. This is what lives in the JsonStore.
export interface InternalTask extends Task {
  read_versions: Record<string, number> | null;
  created_at: string;
  updated_at: string;
  assigned_at: string | null;
  last_error: string | null;
}
