import type { z } from "zod";
import {
  commitRequestSchema,
  createTasksRequestSchema,
  doneRequestSchema,
  envelopeSchema,
  fetchRequestSchema,
  listFilesRequestSchema,
} from "./schemas/router.schemas.js";

type FetchRequest = z.output<typeof fetchRequestSchema>;
type ListFilesRequest = z.output<typeof listFilesRequestSchema>;
type CommitRequest = z.output<typeof commitRequestSchema>;
type CreateTasksRequest = z.output<typeof createTasksRequestSchema>;
type DoneRequest = z.output<typeof doneRequestSchema>;
type Envelope = z.output<typeof envelopeSchema>;

export function buildListFilesRequest(): ListFilesRequest {
  const input: z.input<typeof listFilesRequestSchema> = {
    kind: listFilesRequestSchema.shape.kind.value,
  };
  return listFilesRequestSchema.parse(input);
}

export function buildFetchRequest(paths: FetchRequest["paths"]): FetchRequest {
  const input: z.input<typeof fetchRequestSchema> = {
    kind: fetchRequestSchema.shape.kind.value,
    paths,
  };
  return fetchRequestSchema.parse(input);
}

export function buildCommitRequest(
  writes: CommitRequest["writes"],
  reads: CommitRequest["reads"],
): CommitRequest {
  const input: z.input<typeof commitRequestSchema> = {
    kind: commitRequestSchema.shape.kind.value,
    writes,
    reads,
  };
  return commitRequestSchema.parse(input);
}

export function buildCreateTasksRequest(
  tasks: CreateTasksRequest["tasks"],
): CreateTasksRequest {
  const input: z.input<typeof createTasksRequestSchema> = {
    kind: createTasksRequestSchema.shape.kind.value,
    tasks,
  };
  return createTasksRequestSchema.parse(input);
}

export function buildDoneRequest(): DoneRequest {
  const input: z.input<typeof doneRequestSchema> = {
    kind: doneRequestSchema.shape.kind.value,
  };
  return doneRequestSchema.parse(input);
}

export function buildEnvelope(
  messageId: Envelope["msg_id"],
  agent: Envelope["agent"],
  taskId: Envelope["task_id"],
  body: Envelope["body"],
): Envelope {
  const input: z.input<typeof envelopeSchema> = {
    msg_id: messageId,
    agent,
    task_id: taskId,
    body,
  };
  return envelopeSchema.parse(input);
}
