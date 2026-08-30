import type { FileRef, FileWrite, MovedFile } from "../storage/file-store.types.js";
import type { FileStore } from "../storage/file-store.js";
import type { InternalTask } from "./task.types.js";

export type OccOutcome =
  | { kind: "committed"; versions: Record<string, number> }
  | { kind: "retry"; strikes: number; moved: MovedFile[] };

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
 *
 * Retries are unbounded. The agent (not the server) decides when to give up.
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
  return { kind: "retry", strikes: task.strikes + 1, moved: result.moved };
}
