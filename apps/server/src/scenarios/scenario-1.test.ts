import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../storage/file-store.js";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { Coordinator } from "../task-server/coordinator.js";
import { NoopPushAdapter } from "../task-server/push-adapter.js";
import { TaskStore } from "../task-server/task-store.js";

/**
 * Demo scenario 1: dependency waiting + versioning STALE rejection.
 *
 * Flow:
 *   T1 backend   commits orders.ts (v1 → v2)                    → done
 *   T2 frontend  fetches orders.ts @ v2, starts writing
 *   T4 backend   commits orders.ts (v2 → v3) — injected mid-run  → done
 *   T2 frontend  tries to commit App.tsx     → STALE (orders.ts moved 2 → 3)
 *   T2 frontend  re-fetches @ v3, commits    → done
 *   T3 qa       reads both, PASS report      → done
 *
 * This test drives the Coordinator directly (no HTTP, no Codex). It proves
 * the OCC + state-machine + downstream-unblock logic behaves exactly as the
 * scenario expects.
 */
describe("Demo scenario 1 — dependency waiting + STALE rejection", () => {
  let dir: string;
  let store: JsonStore;
  let fileStore: FileStore;
  let taskStore: TaskStore;
  let coordinator: Coordinator;

  const makeAgent = (id: string, description: string): Agent => ({
    id,
    name: id,
    description,
    instructions: "",
    status: "ready",
    workspacePath: `/tmp/${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("waitUntil timed out");
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scenario1-"));
    store = new JsonStore(path.join(dir, "db.json"));
    await store.initialize();
    // Seed the three scenario agents with fixed ids matching task owner refs.
    await store.mutate((db) => {
      db.agents.push(
        makeAgent("backend", "Owns the order API in repoB."),
        makeAgent("frontend", "Owns the web UI in repoA."),
        makeAgent("qa", "Reviews both repos and assigns fixes."),
      );
    });
    fileStore = new FileStore(store);
    taskStore = new TaskStore(store);
    coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter: new NoopPushAdapter() });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the full scenario: T1 → T2 fetch → T4 → T2 STALE → T2 retry → T3 PASS", async () => {
    // ─── Submit the initial DAG (T1 → T2 → T3) ────────────────────
    await coordinator.submitTasks([
      { id: "T1", detail: "backend adds cancelOrder", owner: "backend", depends_on: [], writes: ["repoB/src/api/orders.ts"] },
      { id: "T2", detail: "frontend adds Cancel button", owner: "frontend", depends_on: ["T1"], writes: ["repoA/src/App.tsx"] },
      { id: "T3", detail: "qa writes PASS/FAIL report", owner: "qa", depends_on: ["T2"], writes: ["qa/report.md"] },
    ]);

    await waitUntil(() => taskStore.get("T1")!.state === "assigned");
    expect(taskStore.get("T2")!.state).toBe("blocked");
    expect(taskStore.get("T3")!.state).toBe("blocked");

    // ─── Backend runs T1: fetch orders.ts @ v1, commit v1 → v2 ────
    const t1Fetch = await coordinator.onFetch("backend", { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(t1Fetch).toHaveLength(1);
    expect(t1Fetch[0]!.version).toBe(1);

    const t1Commit = await coordinator.onCommit("backend", "T1", {
      kind: "commit",
      reads: [],
      writes: [{ path: "repoB/src/api/orders.ts", content: "// v2 with cancelOrder\n", based_on: 1 }],
    });
    expect(t1Commit).toEqual({ ok: true, kind: "committed", new_versions: { "repoB/src/api/orders.ts": 2 } });

    await coordinator.onDone("backend", "T1", { kind: "done" });
    expect(taskStore.get("T1")!.state).toBe("done");

    // ─── T2 becomes assigned to frontend after T1's done tick ─────
    await waitUntil(() => taskStore.get("T2")!.state === "assigned");

    // ─── Frontend fetches orders.ts @ v2 (records read version 2) ─
    const t2Fetch = await coordinator.onFetch("frontend", { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(t2Fetch[0]!.version).toBe(2);
    expect(t2Fetch[0]!.content).toContain("cancelOrder");

    // ─── Mid-run: submit T4 (no deps, backend rewrites orders.ts) ─
    await coordinator.submitTasks([
      { id: "T4", detail: "backend renames order_id → orderId", owner: "backend", depends_on: [], writes: ["repoB/src/api/orders.ts"] },
    ]);
    await waitUntil(() => taskStore.get("T4")!.state === "assigned");

    // ─── Backend runs T4: fetch @ v2, commit v2 → v3 ──────────────
    const t4Fetch = await coordinator.onFetch("backend", { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(t4Fetch[0]!.version).toBe(2);

    const t4Commit = await coordinator.onCommit("backend", "T4", {
      kind: "commit",
      reads: [],
      writes: [{ path: "repoB/src/api/orders.ts", content: "// v3 with orderId\n", based_on: 2 }],
    });
    expect(t4Commit).toEqual({ ok: true, kind: "committed", new_versions: { "repoB/src/api/orders.ts": 3 } });

    await coordinator.onDone("backend", "T4", { kind: "done" });
    expect(taskStore.get("T4")!.state).toBe("done");

    // ─── Frontend commits T2 → STALE because orders.ts moved 2 → 3
    const t2StaleCommit = await coordinator.onCommit("frontend", "T2", {
      kind: "commit",
      reads: [{ path: "repoB/src/api/orders.ts", version: 2 }],
      writes: [{ path: "repoA/src/App.tsx", content: "// UI v2 with Cancel button\n", based_on: 1 }],
    });
    expect(t2StaleCommit.ok).toBe(false);
    if (!t2StaleCommit.ok) {
      expect(t2StaleCommit.code).toBe("STALE");
      const moved = "moved" in t2StaleCommit ? t2StaleCommit.moved : [];
      expect(moved).toContainEqual({ path: "repoB/src/api/orders.ts", had: 2, now: 3 });
    }
    // Task stays assigned; strikes counter records the conflict; no re-dispatch.
    expect(taskStore.get("T2")!.state).toBe("assigned");
    expect(taskStore.get("T2")!.strikes).toBe(1);

    // ─── Frontend re-fetches orders.ts @ v3 (fresh read) ──────────
    const t2Refetch = await coordinator.onFetch("frontend", { kind: "fetch", paths: ["repoB/src/api/orders.ts"] });
    expect(t2Refetch[0]!.version).toBe(3);
    expect(t2Refetch[0]!.content).toContain("orderId");

    // ─── Frontend commits again with fresh versions → ok ──────────
    const t2Commit = await coordinator.onCommit("frontend", "T2", {
      kind: "commit",
      reads: [{ path: "repoB/src/api/orders.ts", version: 3 }],
      writes: [{ path: "repoA/src/App.tsx", content: "// UI v2 with Cancel button (using orderId)\n", based_on: 1 }],
    });
    expect(t2Commit).toEqual({ ok: true, kind: "committed", new_versions: { "repoA/src/App.tsx": 2 } });

    await coordinator.onDone("frontend", "T2", { kind: "done" });
    expect(taskStore.get("T2")!.state).toBe("done");

    // ─── T3 becomes assigned to qa after T2's done tick ───────────
    await waitUntil(() => taskStore.get("T3")!.state === "assigned");

    // ─── QA fetches both, writes a PASS report, commits, done ─────
    const qaFetch = await coordinator.onFetch("qa", {
      kind: "fetch",
      paths: ["repoA/src/App.tsx", "repoB/src/api/orders.ts"],
    });
    expect(qaFetch).toHaveLength(2);
    // Frontend uses orderId; backend defines orderId → they agree → PASS
    expect(qaFetch.find((f) => f.path === "repoA/src/App.tsx")!.content).toContain("orderId");
    expect(qaFetch.find((f) => f.path === "repoB/src/api/orders.ts")!.content).toContain("orderId");

    const t3Commit = await coordinator.onCommit("qa", "T3", {
      kind: "commit",
      reads: [
        { path: "repoA/src/App.tsx", version: 2 },
        { path: "repoB/src/api/orders.ts", version: 3 },
      ],
      writes: [{ path: "qa/report.md", content: "PASS\nfrontend uses the field name the backend defines (orderId).\n", based_on: null }],
    });
    expect(t3Commit).toEqual({ ok: true, kind: "committed", new_versions: { "qa/report.md": 1 } });

    await coordinator.onDone("qa", "T3", { kind: "done" });

    // ─── Final assertions ─────────────────────────────────────────
    expect(taskStore.get("T1")!.state).toBe("done");
    expect(taskStore.get("T2")!.state).toBe("done");
    expect(taskStore.get("T3")!.state).toBe("done");
    expect(taskStore.get("T4")!.state).toBe("done");

    // Final file versions match the expected timeline.
    const finalHead = await fileStore.list();
    const versionOf = (path: string) => finalHead.find((f) => f.path === path)?.version;
    expect(versionOf("repoB/src/api/orders.ts")).toBe(3);
    expect(versionOf("repoA/src/App.tsx")).toBe(2);
    expect(versionOf("qa/report.md")).toBe(1);

    // Event audit log records both the STALE and the committed outcomes.
    const events = store.snapshot().events;
    const commitEvents = events.filter((e) => e.type === "commit_ok" || e.type === "commit_rejected");
    // Expected: T1 ok, T4 ok, T2 rejected (STALE), T2 ok, T3 ok
    expect(commitEvents.map((e) => `${e.type}:${e.taskId}`)).toEqual([
      "commit_ok:T1",
      "commit_ok:T4",
      "commit_rejected:T2",
      "commit_ok:T2",
      "commit_ok:T3",
    ]);
  });
});
