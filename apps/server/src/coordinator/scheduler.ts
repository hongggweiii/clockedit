import type { Agent, Task } from "../types.js";
import { conflictsWithAny } from "./intent-graph.js";
import type { AgentPool } from "./agent-pool.js";

export interface DispatchDecision {
  taskId: string;
  agent: Agent;
}

export interface SchedulerPlan {
  markReady: string[];
  dispatch: DispatchDecision[];
}

const INFLIGHT_STATES = new Set<Task["state"]>([
  "dispatched",
  "running",
  "committing",
]);

export function plan(tasks: readonly Task[], agentPool: AgentPool): SchedulerPlan {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const completed = new Set(tasks.filter((t) => t.state === "completed").map((t) => t.id));
  const inflight = tasks.filter((t) => INFLIGHT_STATES.has(t.state));
  const inflightIntents = inflight.map((t) => t.intent);

  const projectedInflightIntents = [...inflightIntents];
  const markReady: string[] = [];

  const readyCandidates = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const task of readyCandidates) {
    if (task.state !== "pending") continue;
    const depsMet = task.dependsOn.every((dep) => completed.has(dep));
    if (!depsMet) continue;
    if (conflictsWithAny(task.intent, projectedInflightIntents)) continue;
    // Also prevent scheduling behind an earlier same-file writer that's still pending upstream
    // (deps already handle the true ordering; this is just about not simultaneously flipping
    // multiple conflicting pendings to ready in the same tick).
    if (markReady.some((id) => conflictsWithAny(task.intent, [byId.get(id)!.intent]))) continue;
    markReady.push(task.id);
    projectedInflightIntents.push(task.intent);
  }

  const dispatch: DispatchDecision[] = [];
  const reservedAgents = new Set<string>();
  const readySet = new Set(markReady);
  const dispatchable = tasks
    .filter((t) => t.state === "ready" || readySet.has(t.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const task of dispatchable) {
    const agent = agentPool.pickIdle(task.role, reservedAgents);
    if (!agent) continue;
    reservedAgents.add(agent.id);
    dispatch.push({ taskId: task.id, agent });
  }

  return { markReady, dispatch };
}
