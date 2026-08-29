import { describe, expect, it } from "vitest";
import { envelopeSchema, responseSchema } from "./router.schemas.js";

const messageId = "5ad35cb4-3863-4c69-94b8-c829fbaa78d3";

describe("router schemas", () => {
  it.each([
    { kind: "claim" },
    { kind: "intent", writes: ["src/App.tsx"] },
    {
      kind: "commit",
      writes: [{ path: "src/App.tsx", content: "updated", based_on: 1 }],
      reads: [],
    },
    { kind: "done" },
  ])("requires a task id for $kind requests", (body) => {
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "frontend",
      task_id: null,
      body,
    }).success).toBe(false);
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "frontend",
      task_id: "task-1",
      body,
    }).success).toBe(true);
  });

  it.each([
    { kind: "fetch", path: "src/App.tsx" },
    { kind: "heartbeat" },
    { kind: "inbox" },
    {
      kind: "create_tasks",
      tasks: [{
        id: "task-1",
        detail: "Build the page",
        owner: null,
        depends_on: [],
        writes: ["src/App.tsx"],
      }],
    },
  ])("allows $kind without a task id", (body) => {
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "orchestrator",
      task_id: null,
      body,
    }).success).toBe(true);
  });

  it("rejects unknown fields and malformed deduplication keys", () => {
    expect(envelopeSchema.safeParse({
      msg_id: "retry-1",
      agent: "backend",
      task_id: null,
      body: { kind: "fetch", path: "src/App.tsx" },
    }).success).toBe(false);
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: null,
      body: { kind: "fetch", path: "src/App.tsx", typo: true },
    }).success).toBe(false);
  });

  it("rejects duplicate paths in a write intent", () => {
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: "task-1",
      body: { kind: "intent", writes: ["src/App.tsx", "src/App.tsx"] },
    }).success).toBe(false);
  });

  it("requires stale responses to identify moved paths", () => {
    const parsed = responseSchema.safeParse({
      ok: false,
      code: "STALE",
      moved: [{ path: "src/App.tsx", had: 7, now: 8 }],
      next: "Refetch and retry.",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires commit responses to return the new versions", () => {
    expect(responseSchema.safeParse({
      ok: true,
      kind: "committed",
      versions: { "src/App.tsx": 8 },
      next: "Continue the task.",
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: true,
      kind: "committed",
      next: "Continue the task.",
    }).success).toBe(false);
  });
});
