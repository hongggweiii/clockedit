import { z } from "zod";
import { taskSchema } from "./task.schemas.js";

/**
 * Server → agent events, delivered over the SSE endpoint on the private
 * task-server. Discriminated by `kind` so the union can grow (task_dropped,
 * task_cancelled, etc.) without breaking existing subscribers.
 */

export const taskAssignedEventSchema = z.strictObject({
  kind: z.literal("task_assigned"),
  task: taskSchema,
});

export const serverEventSchema = z.discriminatedUnion("kind", [
  taskAssignedEventSchema,
]);

export type TaskAssignedEvent = z.infer<typeof taskAssignedEventSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
