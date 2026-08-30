import type { FileRef, FileWrite } from "../storage/file-store.types.js";
import type { FileStore } from "./version-store.js";
import type { InternalTask } from "./task.types.js";

// Matches strikes cap in shared task schema (0..3).
export const MAX_STRIKES = 3;

export type OccOutcome =
  | { kind: "committed"; newVersions: Record<string, number> }
  | { kind: "retry"; strikes: number; conflictedPaths: string[] }
  | { kind: "exhausted"; strikes: number; conflictedPaths: string[] };

export interface OccInput {
  task: InternalTask;
  agentId: string;
  reads: readonly FileRef[];
  writes: readonly FileWrite[];
  fileStore: FileStore;
}

/**
 * OCC policy for commit-time. Delegates atomic version check + apply to
 * FileStore.commit; interprets the result into a state-machine outcome
 * (advance to `done`, retry into `blocked`, or `escalated`).
 */
export async function evaluateCommit({
  task,
  agentId,
  reads,
  writes,
  fileStore,
}: OccInput): Promise<OccOutcome> {
  const result = await fileStore.commit({
    agentId,
    taskId: task.id,
    reads,
    writes,
  });
  if (result.ok) {
    return { kind: "committed", newVersions: result.newVersions };
  }
  const nextStrikes = task.strikes + 1;
  if (nextStrikes >= MAX_STRIKES) {
    return { kind: "exhausted", strikes: nextStrikes, conflictedPaths: result.conflictedPaths };
  }
  return { kind: "retry", strikes: nextStrikes, conflictedPaths: result.conflictedPaths };
}
