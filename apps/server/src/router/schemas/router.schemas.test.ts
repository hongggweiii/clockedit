import { describe, expect, it } from "vitest";
import { envelopeSchema, responseSchema } from "./router.schemas.js";

const messageId = "5ad35cb4-3863-4c69-94b8-c829fbaa78d3";

describe("router schemas", () => {
  it("requires a task id for done requests", () => {
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "frontend",
      task_id: null,
      body: { kind: "done", task_id: "task-1" },
    }).success).toBe(false);
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "frontend",
      task_id: null,
      body: { kind: "fetch", paths: ["src/App.tsx"] },
    }).success).toBe(true);
  });

  it("rejects unknown fields and malformed deduplication keys", () => {
    expect(envelopeSchema.safeParse({
      msg_id: "retry-1",
      agent: "backend",
      task_id: null,
      body: { kind: "fetch", paths: ["src/App.tsx"] },
    }).success).toBe(false);
    expect(envelopeSchema.safeParse({
      msg_id: messageId,
      agent: "backend",
      task_id: null,
      body: { kind: "fetch", paths: ["src/App.tsx"], typo: true },
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
    });
    expect(parsed.success).toBe(true);
  });
});
