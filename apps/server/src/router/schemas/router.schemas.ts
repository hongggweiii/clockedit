import { z } from "zod";
import { eventSchema } from "./event.schemas.js";
import { newTaskSchema, taskSchema } from "./task.schemas.js";
import { fileRefSchema, fileWriteSchema, pathSchema, uniquePaths } from "./file.schemas.js";
import { taskIdSchema } from "./task.schemas.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const fileVersionSchema = z.number().int().nonnegative();
const nextSchema = nonEmptyStringSchema;

export const COORDINATION_SCHEMA_VERSION = 1 as const;

export const claimRequestSchema = z.strictObject({ kind: z.literal("claim") });

export const intentRequestSchema = z.strictObject({
  kind: z.literal("intent"),
  writes: uniquePaths(pathSchema, (path) => path).min(1),
});

export const fetchRequestSchema = z.strictObject({
  kind: z.literal("fetch"),
  path: pathSchema,
});

export const commitRequestSchema = z.strictObject({
  kind: z.literal("commit"),
  writes: uniquePaths(fileWriteSchema, (write) => write.path).min(1),
  reads: uniquePaths(fileRefSchema, (read) => read.path),
});

export const doneRequestSchema = z.strictObject({ kind: z.literal("done")});

export const heartbeatRequestSchema = z.strictObject({ kind: z.literal("heartbeat") });

export const inboxRequestSchema = z.strictObject({ kind: z.literal("inbox") });

export const createTasksRequestSchema = z.strictObject({ kind: z.literal("create_tasks"), tasks: z.array(newTaskSchema).min(1).max(256) });

export const requestSchema = z.discriminatedUnion("kind", [
  claimRequestSchema,
  intentRequestSchema,
  fetchRequestSchema,
  commitRequestSchema,
  heartbeatRequestSchema,
  inboxRequestSchema,
  doneRequestSchema,
  createTasksRequestSchema,
]);

const taskScopedRequestKinds = new Set(["claim", "intent", "commit", "done"]);
export const envelopeSchema = z.strictObject({
  msg_id: z.uuid(), agent: nonEmptyStringSchema, task_id: taskIdSchema.nullable(), body: requestSchema,
}).superRefine((envelope, context) => {
  if (taskScopedRequestKinds.has(envelope.body.kind) && envelope.task_id === null) {
    context.addIssue({ code: "custom", path: ["task_id"], message: envelope.body.kind + " requires a task_id" });
  }
});

const movedFileSchema = z.strictObject({ path: pathSchema, had: fileVersionSchema, now: fileVersionSchema });

export const responseSchema = z.union([
  z.strictObject({ ok: z.literal(true), kind: z.literal("claimed"), task: taskSchema, next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("intent_accepted"), writes: uniquePaths(pathSchema, (path) => path).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("file"), path: pathSchema, version: fileVersionSchema, content: z.string(), next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("committed"), versions: z.record(pathSchema, fileVersionSchema), next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("heartbeat"), next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("inbox"), tasks: z.array(taskSchema), events: z.array(eventSchema), next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("done"), task_id: taskIdSchema, next: nextSchema }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("tasks_created"), tasks: z.array(taskSchema).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("NOT_OWNER"), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("NOT_FOUND"), path: pathSchema, next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("STALE"), moved: z.array(movedFileSchema).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("TASK_BLOCKED"), depends_on: z.array(taskIdSchema).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("TASK_TAKEN"), owner: nonEmptyStringSchema, next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("INTENT_CONFLICT"), paths: uniquePaths(pathSchema, (path) => path).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("FROZEN"), paths: uniquePaths(pathSchema, (path) => path).min(1), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("FORBIDDEN"), next: nextSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("INVALID_STATE"), detail: nonEmptyStringSchema, next: nextSchema }),
]);
