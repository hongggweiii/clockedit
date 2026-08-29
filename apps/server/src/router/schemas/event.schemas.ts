import { z } from "zod";
import { taskIdSchema } from "./task.schemas.js";

export const eventTypeSchema = z.enum([
  "assigned",
  "intent_declared",
  "intent_conflict",
  "commit_ok",
  "commit_rejected",
  "done",
  "heartbeat_expired",
  "requeued",
  "escalated",
  "resolved",
]);

export const eventSchema = z.strictObject({
  seq: z.number().int().positive(),
  type: eventTypeSchema,
  agent: z.string().trim().min(1),
  task_id: taskIdSchema,
  detail: z.string(),
});
