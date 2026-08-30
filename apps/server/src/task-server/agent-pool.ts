import type { Agent } from "../types.js";

/**
 * Under the push model dispatch is targeted (Task.owner is an agent id), so
 * the pool is a thin idle-check over a live agent snapshot.
 */
export interface AgentPool {
  isIdle(agentId: string): boolean;
  exists(agentId: string): boolean;
}

export function createAgentPool(getAgents: () => readonly Agent[]): AgentPool {
  return {
    isIdle(agentId) {
      const agent = getAgents().find((a) => a.id === agentId);
      return agent?.status === "ready";
    },
    exists(agentId) {
      return getAgents().some((a) => a.id === agentId);
    },
  };
}
