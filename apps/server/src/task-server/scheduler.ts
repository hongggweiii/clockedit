import type { AgentPool } from "./agent-pool.js";
import { conflictsWithAny } from "./intent-graph.js";
import type { InternalTask, TaskState } from "./task.types.js";

/**
 * Pure planner. Given the current task set and an agent-pool idle-check,
 * decide what transitions to apply this tick.
 *
 * Dispatch is owner-targeted: Task.owner is a specific agent id and dispatch
 * only fires when that agent is idle.
 */

export interface SchedulerPlan {
  markUnassigned: string[];
  dispatch: Array<{ taskId: string; ownerId: string }>;
}

const IN_FLIGHT: TaskState = "assigned";

export function plan(tasks: readonly InternalTask[], agentPool: AgentPool): SchedulerPlan {
  const done = new Set(tasks.filter((t) => t.state === "done").map((t) => t.id));
  const inflight = tasks.filter((t) => t.state === IN_FLIGHT);
  const inflightWrites: string[][] = inflight.map((t) => t.writes);

  const sorted = [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const markUnassigned: string[] = [];
  for (const task of sorted) {
    if (task.state !== "blocked") continue;
    if (!task.depends_on.every((dep) => done.has(dep))) continue;
    markUnassigned.push(task.id);
  }

  const projectedInflightWrites = [...inflightWrites];
  const unassignedSet = new Set(markUnassigned);
  const dispatchable = sorted.filter(
    (t) => t.state === "unassigned" || unassignedSet.has(t.id),
  );

  const dispatch: Array<{ taskId: string; ownerId: string }> = [];
  const reservedAgents = new Set<string>();

  for (const task of dispatchable) {
    if (!task.owner) continue;
    if (reservedAgents.has(task.owner)) continue;
    if (!agentPool.isIdle(task.owner)) continue;
    if (conflictsWithAny(task.writes, projectedInflightWrites)) continue;
    dispatch.push({ taskId: task.id, ownerId: task.owner });
    reservedAgents.add(task.owner);
    projectedInflightWrites.push(task.writes);
  }

  return { markUnassigned, dispatch };
}
