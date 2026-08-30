import type { FileRef, FileWrite, MovedFile } from "../storage/file-store.types.js";
import type { FileStore } from "../storage/file-store.js";
import type { InternalTask } from "./task.types.js";

// Matches strikes cap in shared task schema (0..3).
export const MAX_STRIKES = 3;

export type OccOutcome =
  | { kind: "committed"; versions: Record<string, number> }
  | { kind: "retry"; strikes: number; moved: MovedFile[] }
  | { kind: "exhausted"; strikes: number; moved: MovedFile[] };

export interface OccInput {
  task: InternalTask;
  agentId: string;
  reads: readonly FileRef[];
  writes: readonly FileWrite[];
  fileStore: FileStore;
}

/**
 * OCC (Optimistic Concurrency Control) policy layer.
 *
 * Delegates the atomic version check + apply to FileStore.commit(), then
 * interprets the CommitResult into a state-machine outcome:
 *   - committed → task advances toward `done`
 *   - retry     → task stays `assigned`; agent must re-fetch + re-commit
 *   - exhausted → task moves to `escalated` (bounded by MAX_STRIKES)
 */
export async function evaluateCommit({
  task,
  agentId,
  reads,
  writes,
  fileStore,
}: OccInput): Promise<OccOutcome> {
  const result = await fileStore.commit(agentId, task.id, [...writes], [...reads]);
  if (result.ok) {
    return { kind: "committed", versions: result.versions };
  }
  const nextStrikes = task.strikes + 1;
  if (nextStrikes >= MAX_STRIKES) {
    return { kind: "exhausted", strikes: nextStrikes, moved: result.moved };
  }
  return { kind: "retry", strikes: nextStrikes, moved: result.moved };
}
