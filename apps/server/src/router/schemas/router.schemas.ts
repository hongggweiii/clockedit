import { z } from "zod";
import { newTaskSchema } from "./task.schemas.js";
import { fileRefSchema, fileWriteSchema, pathSchema, uniquePaths } from "./file.schemas.js";
import { taskIdSchema } from "./task.schemas.js";

const nonEmptyStringSchema = z.string().trim().min(1);
const fileVersionSchema = z.number().int().nonnegative();

export const fetchRequestSchema = z.strictObject({
  kind: z.literal("fetch"),
  paths: uniquePaths(pathSchema, (path) => path).min(1),
});

export const listFilesRequestSchema = z.strictObject({
  kind: z.literal("list_files"),
});

export const commitRequestSchema = z.strictObject({
  kind: z.literal("commit"),
  writes: uniquePaths(fileWriteSchema, (write) => write.path).min(1),
  reads: uniquePaths(fileRefSchema, (read) => read.path),
});

export const doneRequestSchema = z.strictObject({ kind: z.literal("done")});

export const createTasksRequestSchema = z.strictObject({ kind: z.literal("create_tasks"), tasks: z.array(newTaskSchema).min(1).max(256) });

export const requestSchema = z.discriminatedUnion("kind", [
  listFilesRequestSchema,
  fetchRequestSchema,
  commitRequestSchema,
  doneRequestSchema,
  createTasksRequestSchema,
]);

const taskScopedRequestKinds = new Set(["commit", "done"]);
export const envelopeSchema = z.strictObject({
  msg_id: z.uuid(), agent: nonEmptyStringSchema, task_id: taskIdSchema.nullable(), body: requestSchema,
}).superRefine((envelope, context) => {
  if (taskScopedRequestKinds.has(envelope.body.kind) && envelope.task_id === null) {
    context.addIssue({ code: "custom", path: ["task_id"], message: envelope.body.kind + " requires a task_id" });
  }
});

const movedFileSchema = z.strictObject({ path: pathSchema, had: fileVersionSchema, now: fileVersionSchema });

export const responseSchema = z.union([
  z.strictObject({ ok: z.literal(true), kind: z.literal("files"), files: uniquePaths(fileRefSchema, (file) => file.path).max(4_096) }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("file"), path: pathSchema, version: fileVersionSchema, content: z.string() }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("committed"), new_versions: z.record(z.string(), fileVersionSchema).optional() }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("done") }),
  z.strictObject({ ok: z.literal(true), kind: z.literal("tasks"), task_ids: z.array(taskIdSchema) }),
  z.strictObject({ ok: z.literal(false), code: z.literal("NOT_FOUND"), path: pathSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("STALE"), moved: z.array(movedFileSchema).min(1) }),
]);
