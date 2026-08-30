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
const fetchedFileSchema = fileRefSchema.extend({ content: z.string() });

export const fileRefsResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("file_refs"),
  files: uniquePaths(fileRefSchema, (file) => file.path).max(4_096),
});

export const filesResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("files"),
  files: uniquePaths(fetchedFileSchema, (file) => file.path).min(1).max(4_096),
});

export const committedResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("committed"),
  new_versions: z.record(z.string(), fileVersionSchema).optional(),
});

export const doneResponseSchema = z.strictObject({ ok: z.literal(true), kind: z.literal("done") });

export const tasksResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("tasks"),
  task_ids: z.array(taskIdSchema),
});

export const notFoundResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("NOT_FOUND"),
  paths: uniquePaths(pathSchema, (path) => path).min(1).max(4_096),
});

export const staleResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("STALE"),
  moved: z.array(movedFileSchema).min(1),
});

export const responseSchema = z.union([
  fileRefsResponseSchema,
  filesResponseSchema,
  committedResponseSchema,
  doneResponseSchema,
  tasksResponseSchema,
  notFoundResponseSchema,
  staleResponseSchema,
]);
