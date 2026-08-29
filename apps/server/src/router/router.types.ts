import type { z } from "zod";
import {
  claimRequestSchema,
  commitRequestSchema,
  createTasksRequestSchema,
  doneRequestSchema,
  envelopeSchema,
  fetchRequestSchema,
  heartbeatRequestSchema,
  inboxRequestSchema,
  intentRequestSchema,
  requestSchema,
  responseSchema,
} from "./schemas/router.schemas.js";
import { eventSchema, eventTypeSchema } from "./schemas/event.schemas.js";

export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type IntentRequest = z.infer<typeof intentRequestSchema>;
export type FetchRequest = z.infer<typeof fetchRequestSchema>;
export type CommitRequest = z.infer<typeof commitRequestSchema>;
export type CreateTasksRequest = z.infer<typeof createTasksRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type InboxRequest = z.infer<typeof inboxRequestSchema>;
export type DoneRequest = z.infer<typeof doneRequestSchema>;

export type Request = z.infer<typeof requestSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Response = z.infer<typeof responseSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type Event = z.infer<typeof eventSchema>;
