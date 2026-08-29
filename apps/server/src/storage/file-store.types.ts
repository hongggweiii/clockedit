import type { z } from "zod";
import { fileRefSchema, fileWriteSchema } from "../router/schemas/file.schemas.js";

export type FileRef = z.infer<typeof fileRefSchema>;
export type FileWrite = z.infer<typeof fileWriteSchema>;

export interface StoredFile {
  path: string;
  version: number;
  content: string;
  updatedBy: string;
  updatedAt: string;
  deleted?: boolean;
}

export interface MovedFile {
  path: string;
  had: number;
  now: number;
}

export type StoredEventType = "assigned" | "commit_ok" | "commit_rejected";

export interface StoredEvent {
  seq: number;
  type: StoredEventType;
  agent: string;
  taskId: string;
  detail: string;
  createdAt: string;
}

export type FetchResult =
  | { ok: true; kind: "file"; path: string; version: number; content: string }
  | { ok: false; code: "NOT_FOUND"; path: string };

export type CommitResult =
  | { ok: true; kind: "committed"; versions: Record<string, number> }
  | { ok: false; code: "STALE"; moved: MovedFile[] };
