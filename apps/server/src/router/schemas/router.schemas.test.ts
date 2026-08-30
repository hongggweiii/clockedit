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
    { body: { kind: "list_files" }, taskId: null },
    { body: { kind: "list_agents" }, taskId: null },
    { body: { kind: "fetch", paths: ["src/App.tsx"] }, taskId: null },
    {
      body: {
        kind: "commit",
        writes: [{ path: "src/App.tsx", content: "updated", based_on: 1 }],
        reads: [],
      },
      taskId: "task-1",
    },
    {
      body: {
        kind: "create_tasks",
        tasks: [{
          id: "task-1",
          detail: "Build the page",
          owner: "frontend",
          depends_on: [],
          writes: ["src/App.tsx"],
        }],
      },
      taskId: null,
    },
  ])("accepts the push-model $body.kind request", ({ body, taskId }) => {
    expect(envelopeSchema.safeParse(envelope(body, taskId)).success).toBe(true);
  });

  it("requires a task id for commit and done", () => {
    expect(envelopeSchema.safeParse(envelope({ kind: "done" })).success).toBe(false);
    expect(envelopeSchema.safeParse(envelope({ kind: "done" }, "task-1")).success).toBe(true);
    expect(envelopeSchema.safeParse(envelope({
      kind: "commit",
      writes: [{ path: "a.ts", content: "x", based_on: null }],
      reads: [],
    })).success).toBe(false);
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
      kind: "files",
      files: [{ path: "src/App.tsx", version: 3, content: "export {};" }],
    }).success).toBe(true);
    expect(responseSchema.safeParse({ ok: true, kind: "committed" }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: false,
      code: "NOT_FOUND",
      paths: ["missing.ts", "other-missing.ts"],
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: false,
      code: "STALE",
      moved: [{ path: "src/App.tsx", had: 7, now: 8 }],
    }).success).toBe(true);
  });

  it("list_files returns path+version references only (kind:file_refs, no content)", () => {
    expect(responseSchema.safeParse({
      ok: true,
      kind: "file_refs",
      files: [
        { path: "repoA/src/App.tsx", version: 1 },
        { path: "shared/order-api.contract.md", version: 3 },
      ],
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      ok: true,
      kind: "file_refs",
      files: [
        { path: "repoA/src/App.tsx", version: 1 },
        { path: "repoA/src/App.tsx", version: 1 },
      ],
    }).success).toBe(false);
  });

  it("validates agent profiles with optional responsibilities", () => {
    expect(responseSchema.safeParse({
      ok: true,
      kind: "agent_profiles",
      agents: [{ id: "backend", description: "Owns APIs" }, { id: "frontend", description: "" }],
    }).success).toBe(true);
  });
});
