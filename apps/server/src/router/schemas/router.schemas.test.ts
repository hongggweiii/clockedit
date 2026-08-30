import { describe, expect, it } from "vitest";
import { envelopeSchema, responseSchema } from "./router.schemas.js";

const messageId = "5ad35cb4-3863-4c69-94b8-c829fbaa78d3";

const envelope = (body: unknown, taskId: string | null = null) => ({
  msg_id: messageId,
  agent: "frontend",
  task_id: taskId,
  body,
});

describe("router schemas", () => {
  it.each([
    { kind: "list_files" },
    { kind: "fetch", paths: ["src/App.tsx"] },
    {
      kind: "commit",
      writes: [{ path: "src/App.tsx", content: "updated", based_on: 1 }],
      reads: [],
    },
    {
      kind: "create_tasks",
      tasks: [{
        id: "task-1",
        detail: "Build the page",
        owner: "frontend",
        depends_on: [],
        writes: ["src/App.tsx"],
      }],
    },
  ])("accepts the push-model $kind request", (body) => {
    expect(envelopeSchema.safeParse(envelope(body)).success).toBe(true);
  });

  it("requires a task id only when reporting done", () => {
    expect(envelopeSchema.safeParse(envelope({ kind: "done" })).success).toBe(false);
    expect(envelopeSchema.safeParse(envelope({ kind: "done" }, "task-1")).success).toBe(true);
  });

  it.each(["claim", "intent", "heartbeat", "inbox"])(
    "rejects the removed %s request",
    (kind) => {
      expect(envelopeSchema.safeParse(envelope({ kind }, "task-1")).success).toBe(false);
    },
  );

  it("rejects unknown fields, malformed ids, and duplicate fetch paths", () => {
    expect(envelopeSchema.safeParse({
      ...envelope({ kind: "fetch", paths: ["src/App.tsx"] }),
      msg_id: "retry-1",
    }).success).toBe(false);
    expect(envelopeSchema.safeParse(envelope({
      kind: "fetch",
      paths: ["src/App.tsx"],
      typo: true,
    })).success).toBe(false);
    expect(envelopeSchema.safeParse(envelope({
      kind: "fetch",
      paths: ["src/App.tsx", "src/App.tsx"],
    })).success).toBe(false);
  });

  it("matches the minimal success and error responses", () => {
    expect(responseSchema.safeParse({
      ok: true,
      kind: "file",
      path: "src/App.tsx",
      version: 3,
      content: "export {};",
    }).success).toBe(true);
    expect(responseSchema.safeParse({ ok: true, kind: "committed" }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: false,
      code: "STALE",
      moved: [{ path: "src/App.tsx", had: 7, now: 8 }],
    }).success).toBe(true);
  });

  it("lists unique file references without exposing file contents", () => {
    expect(responseSchema.safeParse({
      ok: true,
      kind: "files",
      files: [
        { path: "repoA/src/App.tsx", version: 1 },
        { path: "shared/order-api.contract.md", version: 3 },
      ],
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: true,
      kind: "files",
      files: [
        { path: "repoA/src/App.tsx", version: 1 },
        { path: "repoA/src/App.tsx", version: 1 },
      ],
    }).success).toBe(false);
  });
});
