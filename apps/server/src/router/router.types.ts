import type { z } from "zod";
import {
  commitRequestSchema,
  createTasksRequestSchema,
  doneRequestSchema,
  envelopeSchema,
  fetchRequestSchema,
  listAgentsRequestSchema,
  listFilesRequestSchema,
  requestSchema,
  responseSchema,
} from "./schemas/router.schemas.js";

export type FetchRequest = z.infer<typeof fetchRequestSchema>;
export type ListAgentsRequest = z.infer<typeof listAgentsRequestSchema>;
export type ListFilesRequest = z.infer<typeof listFilesRequestSchema>;
export type CommitRequest = z.infer<typeof commitRequestSchema>;
export type CreateTasksRequest = z.infer<typeof createTasksRequestSchema>;
export type DoneRequest = z.infer<typeof doneRequestSchema>;

export type Request = z.infer<typeof requestSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type Response = z.infer<typeof responseSchema>;

export type RouterEvent =
  | {
      seq: number;
      at: string;
      type: "request";
      msg_id: string;
      agent: string;
      task_id: string | null;
      payload: Envelope;
    }
  | {
      seq: number;
      at: string;
      type: "response";
      msg_id: string | null;
      agent: string;
      task_id: string | null;
      payload: Response;
    }
  | {
      seq: number;
      at: string;
      type: "error";
      msg_id: string | null;
      agent: string;
      task_id: string | null;
      error: string;
    };
