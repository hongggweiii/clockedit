import { describe, expect, it } from "vitest";
import { plan } from "./scheduler.js";
import { createAgentPool } from "./agent-pool.js";
import type { Agent, Task } from "../types.js";

function makeAgent(id: string, role: string, status: Agent["status"] = "ready"): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status,
    workspacePath: `/tmp/${id}`,
    codexThreadId: null,
    lastError: null,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    projectId: "p",
    title: overrides.id,
    description: "",
    role: "frontend",
    dependsOn: [],
    intent: { reads: [], writes: [] },
    state: "pending",
    attempt: 0,
    assignedAgentId: null,
    runId: null,
    readVersions: null,
    writtenPaths: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("scheduler.plan", () => {
  it("marks pending tasks with met deps as ready and dispatches", () => {
    const tasks: Task[] = [
      makeTask({ id: "t1", role: "frontend", intent: { reads: [], writes: ["a.ts"] } }),
    ];
    const agents = [makeAgent("a1", "frontend")];
    const pool = createAgentPool(() => agents);
    const result = plan(tasks, pool);
    expect(result.markReady).toEqual(["t1"]);
    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0]!.agent.id).toBe("a1");
  });

  it("does not dispatch when no idle agent for role", () => {
    const tasks: Task[] = [makeTask({ id: "t1", role: "backend" })];
    const agents = [makeAgent("a1", "frontend")];
    const pool = createAgentPool(() => agents);
    const result = plan(tasks, pool);
    expect(result.dispatch).toHaveLength(0);
  });

  it("sequences two writers on the same file", () => {
    const tasks: Task[] = [
      makeTask({ id: "t1", intent: { reads: [], writes: ["shared.ts"] } }),
      makeTask({ id: "t2", intent: { reads: [], writes: ["shared.ts"] }, createdAt: "2026-01-01T00:00:01.000Z" }),
    ];
    const agents = [makeAgent("a1", "frontend"), makeAgent("a2", "frontend")];
    const pool = createAgentPool(() => agents);
    const result = plan(tasks, pool);
    expect(result.markReady).toEqual(["t1"]);
    expect(result.dispatch).toHaveLength(1);
  });

  it("respects dependsOn", () => {
    const tasks: Task[] = [
      makeTask({ id: "t1", state: "running" }),
      makeTask({ id: "t2", dependsOn: ["t1"] }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1", "frontend")]);
    const result = plan(tasks, pool);
    expect(result.markReady).not.toContain("t2");
  });

  it("does not dispatch a pending task that conflicts with an inflight task", () => {
    const tasks: Task[] = [
      makeTask({ id: "t1", state: "running", intent: { reads: [], writes: ["x.ts"] } }),
      makeTask({ id: "t2", intent: { reads: [], writes: ["x.ts"] } }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1", "frontend")]);
    const result = plan(tasks, pool);
    expect(result.markReady).not.toContain("t2");
    expect(result.dispatch).toHaveLength(0);
  });
});
