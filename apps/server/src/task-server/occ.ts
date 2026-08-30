import type { Task } from "../types.js";
import type { VersionStore } from "./version-store.js";

export const MAX_ATTEMPTS = 5;

export type OccOutcome =
  | { kind: "committed"; newVersions: Record<string, string> }
  | { kind: "retry"; attempt: number; conflictedPaths: string[] }
  | { kind: "exhausted"; attempt: number; conflictedPaths: string[] };

export interface OccInput {
  task: Task;
  writtenPaths: string[];
  versionStore: VersionStore;
}

export async function evaluateCommit({
  task,
  writtenPaths,
  versionStore,
}: OccInput): Promise<OccOutcome> {
  const expected = task.readVersions ?? {};
  const result = await versionStore.commit({
    projectId: task.projectId,
    agentId: task.assignedAgentId ?? "",
    taskId: task.id,
    expectedVersions: expected,
    writtenPaths,
  });
  if (result.ok) {
    return { kind: "committed", newVersions: result.newVersions };
  }
  const nextAttempt = task.attempt + 1;
  if (nextAttempt >= MAX_ATTEMPTS) {
    return { kind: "exhausted", attempt: nextAttempt, conflictedPaths: result.conflictedPaths };
  }
  return { kind: "retry", attempt: nextAttempt, conflictedPaths: result.conflictedPaths };
}
