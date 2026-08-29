import type { z } from "zod";
import {
  commitRequestSchema,
  createTasksRequestSchema,
  doneRequestSchema,
  envelopeSchema,
  fetchRequestSchema,
  requestSchema,
  responseSchema,
} from "./schemas/router.schemas.js";

export type FetchRequest = z.infer<typeof fetchRequestSchema>;
export type CommitRequest = z.infer<typeof commitRequestSchema>;
export type CreateTasksRequest = z.infer<typeof createTasksRequestSchema>;
export type DoneRequest = z.infer<typeof doneRequestSchema>;

export type Request = z.infer<typeof requestSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Response = z.infer<typeof responseSchema>;
