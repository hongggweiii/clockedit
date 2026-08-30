import { describe, expect, it } from "vitest";
import { taskSchema } from "./task.schemas.js";

describe("task coordination schemas", () => {
  it("validates task states and details", () => {
    const task = { id: "task-1", detail: "Do work", state: "assigned", owner: "backend", depends_on: [], writes: [], strikes: 3 };
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, state: "running" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, state: "escalated" }).success).toBe(false);
    // Strikes are unbounded (no MAX_STRIKES / escalation).
    expect(taskSchema.safeParse({ ...task, strikes: 42 }).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, strikes: -1 }).success).toBe(false);
  });

  it("allows an unassigned task to have no owner", () => {
    expect(taskSchema.safeParse({ id: "task-2", detail: "Find an agent", state: "unassigned", owner: null, depends_on: [], writes: [], strikes: 0 }).success).toBe(true);
  });
});
