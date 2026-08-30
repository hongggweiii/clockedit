import type { Agent } from "../types.js";

export interface AgentPool {
  pickIdle(role: string, excludeAgentIds?: ReadonlySet<string>): Agent | null;
  hasRole(role: string): boolean;
  rolesRegistered(): string[];
}

export function createAgentPool(getAgents: () => readonly Agent[]): AgentPool {
  return {
    pickIdle(role, excludeAgentIds) {
      for (const agent of getAgents()) {
        if (agent.role !== role) continue;
        if (agent.status !== "ready") continue;
        if (excludeAgentIds?.has(agent.id)) continue;
        return agent;
      }
      return null;
    },
    hasRole(role) {
      for (const agent of getAgents()) {
        if (agent.role === role) return true;
      }
      return false;
    },
    rolesRegistered() {
      const roles = new Set<string>();
      for (const agent of getAgents()) {
        if (agent.role) roles.add(agent.role);
      }
      return [...roles];
    },
  };
}
