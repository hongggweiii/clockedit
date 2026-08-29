import type { z } from "zod";
import { newTaskSchema, taskSchema, taskStateSchema } from "../router/schemas/task.schemas.js";

export type TaskState = z.infer<typeof taskStateSchema>;
export type Task = z.infer<typeof taskSchema>;
export type NewTask = z.infer<typeof newTaskSchema>;
