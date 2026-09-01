import { describe, expect, it } from "vitest";
import { plan } from "./scheduler.js";
import { createAgentPool } from "./agent-pool.js";
import type { Agent } from "../types.js";
import type { InternalTask } from "./task.types.js";

function makeAgent(id: string, status: Agent["status"] = "ready"): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status,
    workspacePath: `/tmp/${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTask(overrides: Partial<InternalTask> & Pick<InternalTask, "id" | "owner">): InternalTask {
  return {
    detail: overrides.id,
    state: "unassigned",
    owner: overrides.owner,
    depends_on: [],
    writes: [],
    strikes: 0,
    read_versions: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    assigned_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("scheduler.plan", () => {
  it("dispatches an unassigned task to its idle owner", () => {
    const agents = [makeAgent("a1")];
    const tasks: InternalTask[] = [makeTask({ id: "t1", owner: "a1", writes: ["a.ts"] })];
    const pool = createAgentPool(() => agents);
    const result = plan(tasks, pool);
    expect(result.dispatch).toEqual([{ taskId: "t1", ownerId: "a1" }]);
  });

  it("does not dispatch when owner is not idle", () => {
    const agents = [makeAgent("a1", "busy")];
    const tasks: InternalTask[] = [makeTask({ id: "t1", owner: "a1" })];
    const pool = createAgentPool(() => agents);
    expect(plan(tasks, pool).dispatch).toEqual([]);
  });

  it("does not dispatch when owner is null", () => {
    const agents = [makeAgent("a1")];
    const tasks: InternalTask[] = [makeTask({ id: "t1", owner: null })];
    const pool = createAgentPool(() => agents);
    expect(plan(tasks, pool).dispatch).toEqual([]);
  });

  it("marks a blocked task as unassigned when its deps are done", () => {
    const tasks: InternalTask[] = [
      makeTask({ id: "t1", owner: "a1", state: "done" }),
      makeTask({ id: "t2", owner: "a1", state: "blocked", depends_on: ["t1"] }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1")]);
    const result = plan(tasks, pool);
    expect(result.markUnassigned).toContain("t2");
    expect(result.dispatch.some((d) => d.taskId === "t2")).toBe(true);
  });

  it("sequences two writers to the same file (does not dispatch both)", () => {
    const tasks: InternalTask[] = [
      makeTask({ id: "t1", owner: "a1", writes: ["shared.ts"] }),
      makeTask({ id: "t2", owner: "a2", writes: ["shared.ts"], created_at: "2026-01-01T00:00:01.000Z" }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1"), makeAgent("a2")]);
    const result = plan(tasks, pool);
    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0]!.taskId).toBe("t1");
  });

  it("does not dispatch a task whose writes conflict with an inflight task", () => {
    const tasks: InternalTask[] = [
      makeTask({ id: "t1", owner: "a1", state: "assigned", writes: ["x.ts"] }),
      makeTask({ id: "t2", owner: "a2", state: "unassigned", writes: ["x.ts"] }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1", "busy"), makeAgent("a2")]);
    const result = plan(tasks, pool);
    expect(result.dispatch).toEqual([]);
  });

  it("respects depends_on: does not mark unblocked while deps assigned", () => {
    const tasks: InternalTask[] = [
      makeTask({ id: "t1", owner: "a1", state: "assigned" }),
      makeTask({ id: "t2", owner: "a1", state: "blocked", depends_on: ["t1"] }),
    ];
    const pool = createAgentPool(() => [makeAgent("a1", "busy")]);
    const result = plan(tasks, pool);
    expect(result.markUnassigned).not.toContain("t2");
  });
});
