import { describe, expect, it } from "vitest";
import {
  envelopeSchema,
  eventSchema,
  responseSchema,
  taskSchema,
} from "./coordination-schema.js";

const messageId = "5ad35cb4-3863-4c69-94b8-c829fbaa78d3";

describe("coordination message schema", () => {
  it.each([
    { kind: "claim" },
    { kind: "intent", writes: ["src/api/orders.ts"] },
    { kind: "commit", writes: [{ path: "src/api/orders.ts", content: "export {};", based_on: 7 }], reads: [{ path: "contracts/order-api.json", version: 3 }] },
    { kind: "done" },
  ])("accepts the task-scoped $kind request", (body) => {
    expect(
      envelopeSchema.safeParse({
        msg_id: messageId,
        agent: "backend",
        task_id: "cancel-order-api",
        body,
      }).success,
    ).toBe(true);
  });

  it.each([
    { kind: "fetch", path: "contracts/order-api.json" },
    { kind: "heartbeat" },
    { kind: "inbox" },
  ])("accepts the non-task-scoped $kind request", (body) => {
    expect(
      envelopeSchema.safeParse({
        msg_id: messageId,
        agent: "frontend",
        task_id: null,
        body,
      }).success,
    ).toBe(true);
  });

  it("requires a task id for messages that change task state", () => {
    const parsed = envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "frontend",
      task_id: null,
      body: { kind: "intent", writes: ["src/App.tsx"] },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["task_id"]);
    }
  });

  it("rejects malformed and ambiguous commit evidence", () => {
    const duplicateWrites = envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: "cancel-order-api",
      body: {
        kind: "commit",
        writes: [
          { path: "src/api/orders.ts", content: "one", based_on: 1 },
          { path: "src/api/orders.ts", content: "two", based_on: 1 },
        ],
        reads: [],
      },
    });
    const negativeVersion = envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: "cancel-order-api",
      body: {
        kind: "commit",
        writes: [{ path: "src/api/orders.ts", content: "one", based_on: -1 }],
        reads: [],
      },
    });

    expect(duplicateWrites.success).toBe(false);
    expect(negativeVersion.success).toBe(false);
  });

  it("uses based_on null when an Agent expects to create a file", () => {
    const parsed = envelopeSchema.parse({
      msg_id: messageId,
      agent: "backend",
      task_id: "cancel-order-api",
      body: {
        kind: "commit",
        writes: [
          {
            path: "contracts/order-api.json",
            content: "{}",
            based_on: null,
          },
        ],
        reads: [],
      },
    });

    expect(parsed.body.kind).toBe("commit");
    if (parsed.body.kind === "commit") {
      expect(parsed.body.writes[0]?.based_on).toBeNull();
    }
  });

  it("requires a UUID deduplication key", () => {
    expect(
      envelopeSchema.safeParse({
        msg_id: "retry-1",
        agent: "backend",
        task_id: null,
        body: { kind: "heartbeat" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields instead of silently ignoring them", () => {
    const parsed = envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: null,
      body: { kind: "heartbeat", typo: true },
    });

    expect(parsed.success).toBe(false);
  });

  it("enforces the documented task states and strike limit", () => {
    const task = {
      id: "frontend-cancel-button",
      state: "assigned",
      owner: "frontend",
      depends_on: ["cancel-order-api"],
      writes: ["src/App.tsx"],
      strikes: 3,
    };

    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, state: "running" }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, strikes: 4 }).success).toBe(false);
  });

  it("represents every path that moved in a stale commit response", () => {
    const parsed = responseSchema.parse({
      ok: false,
      code: "STALE",
      moved: [
        { path: "contracts/order-api.json", had: 3, now: 4 },
        { path: "src/App.tsx", had: 7, now: 8 },
      ],
      next: "Refetch the moved files and retry the task.",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.code === "STALE") {
      expect(parsed.moved).toHaveLength(2);
    }
  });

  it("requires conflict responses to identify the overlapping paths", () => {
    expect(
      responseSchema.safeParse({
        ok: false,
        code: "INTENT_CONFLICT",
        paths: ["src/api/orders.ts"],
        next: "Wait for a human decision.",
      }).success,
    ).toBe(true);
    expect(
      responseSchema.safeParse({
        ok: false,
        code: "INTENT_CONFLICT",
        paths: [],
        next: "Wait for a human decision.",
      }).success,
    ).toBe(false);
  });

  it("validates append-only event records", () => {
    expect(
      eventSchema.safeParse({
        seq: 1,
        type: "assigned",
        agent: "backend",
        task_id: "cancel-order-api",
        detail: "Task assigned after its dependencies cleared.",
      }).success,
    ).toBe(true);
    expect(
      eventSchema.safeParse({
        seq: 0,
        type: "assigned",
        agent: "backend",
        task_id: "cancel-order-api",
        detail: "Invalid sequence number.",
      }).success,
    ).toBe(false);
  });
});
