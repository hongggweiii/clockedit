import { z } from "zod";

/**
 * Wire contract between an Agent Runtime and the coordination server.
 *
 * The schemas are strict on purpose: a misspelled or unexpected field must be
 * rejected at the server boundary instead of being silently ignored.
 */
export const COORDINATION_SCHEMA_VERSION = 1 as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const pathSchema = nonEmptyStringSchema;
const fileVersionSchema = z.number().int().nonnegative();
const nextSchema = nonEmptyStringSchema;

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function uniquePaths<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  pathOf: (value: z.output<TSchema>) => string,
) {
  return z.array(schema).superRefine((values, context) => {
    const paths = values.map(pathOf);
    if (hasDuplicates(paths)) {
      context.addIssue({
        code: "custom",
        message: "Each path may appear only once",
      });
    }
  });
}

// ---------- Task ----------

export const taskStateSchema = z.enum([
  "blocked",
  "assigned",
  "escalated",
  "done",
]);

export const taskSchema = z.strictObject({
  id: nonEmptyStringSchema,
  state: taskStateSchema,

  // Immutable fields supplied by the plan.
  owner: nonEmptyStringSchema,
  depends_on: z.array(nonEmptyStringSchema).superRefine((values, context) => {
    if (hasDuplicates(values)) {
      context.addIssue({
        code: "custom",
        message: "A dependency may be listed only once",
      });
    }
  }),
  writes: z.array(pathSchema).superRefine((values, context) => {
    if (hasDuplicates(values)) {
      context.addIssue({
        code: "custom",
        message: "A write intent may be listed only once",
      });
    }
  }),

  // Runtime state. Three strikes is the final attempt before escalation.
  strikes: z.number().int().min(0).max(3),
});

export type TaskState = z.infer<typeof taskStateSchema>;
export type Task = z.infer<typeof taskSchema>;

// ---------- Shared ----------

export const fileRefSchema = z.strictObject({
  path: pathSchema,
  version: fileVersionSchema,
});

export const fileWriteSchema = z.strictObject({
  path: pathSchema,
  content: z.string(),
  // null means the Agent expects to create a new file.
  based_on: fileVersionSchema.nullable(),
});

export type FileRef = z.infer<typeof fileRefSchema>;
export type FileWrite = z.infer<typeof fileWriteSchema>;

// ---------- Agent -> server ----------

export const claimRequestSchema = z.strictObject({
  kind: z.literal("claim"),
});

export const intentRequestSchema = z.strictObject({
  kind: z.literal("intent"),
  writes: z
    .array(pathSchema)
    .min(1)
    .superRefine((values, context) => {
      if (hasDuplicates(values)) {
        context.addIssue({
          code: "custom",
          message: "A write intent may be listed only once",
        });
      }
    }),
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

export const heartbeatRequestSchema = z.strictObject({
  kind: z.literal("heartbeat"),
});

export const inboxRequestSchema = z.strictObject({
  kind: z.literal("inbox"),
});

export const doneRequestSchema = z.strictObject({
  kind: z.literal("done"),
});

export const requestSchema = z.discriminatedUnion("kind", [
  claimRequestSchema,
  intentRequestSchema,
  fetchRequestSchema,
  commitRequestSchema,
  heartbeatRequestSchema,
  inboxRequestSchema,
  doneRequestSchema,
]);

const taskScopedRequestKinds = new Set<Request["kind"]>([
  "claim",
  "intent",
  "commit",
  "done",
]);

export const envelopeSchema = z
  .strictObject({
    msg_id: z.string().uuid(),
    agent: nonEmptyStringSchema,
    task_id: nonEmptyStringSchema.nullable(),
    body: requestSchema,
  })
  .superRefine((envelope, context) => {
    if (
      taskScopedRequestKinds.has(envelope.body.kind) &&
      envelope.task_id === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["task_id"],
        message: envelope.body.kind + " requires a task_id",
      });
    }
  });

export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type IntentRequest = z.infer<typeof intentRequestSchema>;
export type FetchRequest = z.infer<typeof fetchRequestSchema>;
export type CommitRequest = z.infer<typeof commitRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type InboxRequest = z.infer<typeof inboxRequestSchema>;
export type DoneRequest = z.infer<typeof doneRequestSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;

// ---------- Events (server-authored, append-only) ----------

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
  agent: nonEmptyStringSchema,
  task_id: nonEmptyStringSchema,
  detail: z.string(),
});

export type EventType = z.infer<typeof eventTypeSchema>;
export type Event = z.infer<typeof eventSchema>;

// ---------- Server -> agent ----------

const movedFileSchema = z.strictObject({
  path: pathSchema,
  had: fileVersionSchema,
  now: fileVersionSchema,
});

const claimedResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("claimed"),
  task: taskSchema,
  next: nextSchema,
});

const intentAcceptedResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("intent_accepted"),
  writes: z.array(pathSchema),
  next: nextSchema,
});

const fileResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("file"),
  path: pathSchema,
  version: fileVersionSchema,
  content: z.string(),
  next: nextSchema,
});

const committedResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("committed"),
  versions: z.record(pathSchema, fileVersionSchema),
  next: nextSchema,
});

const heartbeatResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("heartbeat"),
  next: nextSchema,
});

const inboxResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("inbox"),
  tasks: z.array(taskSchema),
  events: z.array(eventSchema),
  next: nextSchema,
});

const doneResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.literal("done"),
  task_id: nonEmptyStringSchema,
  next: nextSchema,
});

const notOwnerResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("NOT_OWNER"),
  next: nextSchema,
});

const notFoundResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("NOT_FOUND"),
  path: pathSchema,
  next: nextSchema,
});

const staleResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("STALE"),
  moved: z.array(movedFileSchema).min(1),
  next: nextSchema,
});

const taskBlockedResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("TASK_BLOCKED"),
  depends_on: z.array(nonEmptyStringSchema).min(1),
  next: nextSchema,
});

const taskTakenResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("TASK_TAKEN"),
  owner: nonEmptyStringSchema,
  next: nextSchema,
});

const intentConflictResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("INTENT_CONFLICT"),
  paths: z.array(pathSchema).min(1),
  next: nextSchema,
});

const frozenResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("FROZEN"),
  paths: z.array(pathSchema).min(1),
  next: nextSchema,
});

const forbiddenResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("FORBIDDEN"),
  next: nextSchema,
});

const invalidStateResponseSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal("INVALID_STATE"),
  detail: nonEmptyStringSchema,
  next: nextSchema,
});

export const responseSchema = z.union([
  claimedResponseSchema,
  intentAcceptedResponseSchema,
  fileResponseSchema,
  committedResponseSchema,
  heartbeatResponseSchema,
  inboxResponseSchema,
  doneResponseSchema,
  notOwnerResponseSchema,
  notFoundResponseSchema,
  staleResponseSchema,
  taskBlockedResponseSchema,
  taskTakenResponseSchema,
  intentConflictResponseSchema,
  frozenResponseSchema,
  forbiddenResponseSchema,
  invalidStateResponseSchema,
]);

export type Response = z.infer<typeof responseSchema>;

export function parseEnvelope(input: unknown): Envelope {
  return envelopeSchema.parse(input);
}

export function parseResponse(input: unknown): Response {
  return responseSchema.parse(input);
}

export function parseEvent(input: unknown): Event {
  return eventSchema.parse(input);
}
