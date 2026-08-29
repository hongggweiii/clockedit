import { describe, expect, it } from "vitest";
import { eventSchema } from "./event.schemas.js";

describe("coordination event schema", () => {
  it("validates numbered server events", () => {
    expect(eventSchema.safeParse({
      seq: 1,
      type: "assigned",
      agent: "backend",
      task_id: "task-1",
      detail: "Task assigned.",
    }).success).toBe(true);
    expect(eventSchema.safeParse({
      seq: 0,
      type: "assigned",
      agent: "backend",
      task_id: "task-1",
      detail: "Invalid sequence.",
    }).success).toBe(false);
  });
});
