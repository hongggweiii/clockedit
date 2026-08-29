import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./file-store.js";
import { JsonStore } from "../store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-file-store-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function createStore(): Promise<{ store: JsonStore; files: FileStore }> {
  const root = await temporaryRoot();
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return { store, files: new FileStore(store) };
}

const visibleFiles = (store: JsonStore) =>
  Object.values(store.snapshot().files)
    .filter((file) => !file.deleted)
    .sort((left, right) => left.path.localeCompare(right.path));

const readSet = (store: JsonStore, agent: string) =>
  store.snapshot().reads[agent] ?? {};

async function seedFile(store: JsonStore, filePath: string, content: string): Promise<void> {
  await store.mutate((database) => {
    const version = (database.files[filePath]?.version ?? 0) + 1;
    database.files[filePath] = {
      path: filePath,
      version,
      content,
      updatedBy: "system",
      updatedAt: new Date().toISOString(),
    };
  });
}

describe("FileStore", () => {
  it("lets exactly one of ten concurrent commits to the same path through", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "repoA/orders.ts", "v1 content");

    const agents = Array.from({ length: 10 }, (_, index) => "agent-" + index);
    const results = await Promise.all(
      agents.map((agent) =>
        files.commit(agent, "task-" + agent, [
          { path: "repoA/orders.ts", content: "written by " + agent, based_on: 1 },
        ]),
      ),
    );

    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((result) => !result.ok && result.code === "STALE")).toBe(true);

    const stored = visibleFiles(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.version).toBe(2);
  });

  it("rejects a commit whose own writes are clean but whose read moved", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/order-api.contract.md", "returns order_id");

    const read = await files.fetch("frontend", "shared/order-api.contract.md");
    expect(read).toEqual({
      ok: true,
      kind: "file",
      path: "shared/order-api.contract.md",
      version: 1,
      content: "returns order_id",
    });

    const backend = await files.commit("backend", "task-backend", [
      {
        path: "shared/order-api.contract.md",
        content: "returns orderId",
        based_on: 1,
      },
    ]);
    expect(backend.ok).toBe(true);

    const frontend = await files.commit("frontend", "task-frontend", [
      { path: "repoA/CancelButton.tsx", content: "reads order_id", based_on: null },
    ]);

    expect(frontend.ok).toBe(false);
    if (frontend.ok) return;
    expect(frontend.code).toBe("STALE");
    expect(frontend.moved).toEqual([
      { path: "shared/order-api.contract.md", had: 1, now: 2 },
    ]);

    expect(visibleFiles(store).map((file) => file.path)).toEqual([
      "shared/order-api.contract.md",
    ]);
  });

  it("honours agent-reported reads from the wire even without a fetch", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/contract.md", "v1");
    await seedFile(store, "shared/contract.md", "v2");

    const result = await files.commit(
      "frontend",
      "task-frontend",
      [{ path: "repoA/out.ts", content: "built on v1", based_on: null }],
      [{ path: "shared/contract.md", version: 1 }],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE");
    expect(result.moved).toEqual([{ path: "shared/contract.md", had: 1, now: 2 }]);
  });

  it("trusts the server-recorded read over a conflicting reported read", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/contract.md", "v1");

    await files.fetch("frontend", "shared/contract.md");

    const result = await files.commit(
      "frontend",
      "task-frontend",
      [{ path: "repoA/out.ts", content: "x", based_on: null }],
      [{ path: "shared/contract.md", version: 9 }],
    );
    expect(result.ok).toBe(true);
  });

  it("changes nothing when a commit is rejected", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "repoA/orders.ts", "original");

    const before = visibleFiles(store);

    const result = await files.commit("agent-1", "task-1", [
      { path: "repoA/orders.ts", content: "should not land", based_on: 7 },
      { path: "repoA/new-file.ts", content: "should not land either", based_on: null },
    ]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.moved).toEqual([
      { path: "repoA/orders.ts", had: 7, now: 1 },
    ]);
    expect(visibleFiles(store)).toEqual(before);
  });

  it("reports every path that moved, not just the first", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "a.ts", "a");
    await seedFile(store, "b.ts", "b");

    const result = await files.commit("agent-1", "task-1", [
      { path: "a.ts", content: "new a", based_on: 5 },
      { path: "b.ts", content: "new b", based_on: null },
    ]);

    expect(result.ok === false && result.moved).toEqual([
      { path: "a.ts", had: 5, now: 1 },
      { path: "b.ts", had: 0, now: 1 },
    ]);
  });

  it("clears the read set after a successful commit", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/contract.md", "v1");

    await files.fetch("agent-1", "shared/contract.md");
    expect(readSet(store, "agent-1")).toEqual({ "shared/contract.md": 1 });

    await files.commit("agent-1", "task-1", [
      { path: "repoA/out.ts", content: "built on v1", based_on: null },
    ]);
    expect(readSet(store, "agent-1")).toEqual({});
  });

  it("keeps the read set after a rejected commit", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/contract.md", "v1");

    await files.fetch("agent-1", "shared/contract.md");
    await files.commit("agent-1", "task-1", [
      { path: "repoA/out.ts", content: "x", based_on: 4 },
    ]);
    expect(readSet(store, "agent-1")).toEqual({ "shared/contract.md": 1 });
  });

  it("deletes a file behind a version check and hides it afterwards", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "repoA/old.ts", "legacy");

    const result = await files.commit("agent-1", "task-1", [
      { path: "repoA/old.ts", content: "", based_on: 1, delete: true },
    ]);
    expect(result).toEqual({
      ok: true,
      kind: "committed",
      versions: { "repoA/old.ts": 2 },
    });

    expect(visibleFiles(store)).toEqual([]);
    expect(await files.fetch("agent-2", "repoA/old.ts")).toEqual({
      ok: false,
      code: "NOT_FOUND",
      path: "repoA/old.ts",
    });
  });

  it("rejects a delete when the file moved", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "repoA/old.ts", "v1");
    await seedFile(store, "repoA/old.ts", "v2");

    const result = await files.commit("agent-1", "task-1", [
      { path: "repoA/old.ts", content: "", based_on: 1, delete: true },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.moved).toEqual([
      { path: "repoA/old.ts", had: 1, now: 2 },
    ]);
  });

  it("refuses to delete a file that is not expected to exist", async () => {
    const { files } = await createStore();
    await expect(
      files.commit("agent-1", "task-1", [
        { path: "repoA/ghost.ts", content: "", based_on: null, delete: true },
      ]),
    ).rejects.toThrow(/not expected to exist/);
  });

  it("keeps counting versions through a delete so stale readers still lose", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "shared/contract.md", "v1");

    await files.fetch("frontend", "shared/contract.md");

    await files.commit("backend", "task-1", [
      { path: "shared/contract.md", content: "", based_on: 1, delete: true },
    ]);
    const recreate = await files.commit("backend", "task-2", [
      { path: "shared/contract.md", content: "brand new", based_on: null },
    ]);
    expect(recreate).toEqual({
      ok: true,
      kind: "committed",
      versions: { "shared/contract.md": 3 },
    });

    const stale = await files.commit("frontend", "task-3", [
      { path: "repoA/out.ts", content: "built on v1", based_on: null },
    ]);
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.moved).toEqual([
      { path: "shared/contract.md", had: 1, now: 3 },
    ]);
  });

  it("rejects a commit built on an observed absence once the file appears", async () => {
    const { files } = await createStore();

    await files.fetch("frontend", "shared/contract.md");

    await files.commit("backend", "task-1", [
      { path: "shared/contract.md", content: "now exists", based_on: null },
    ]);

    const result = await files.commit("frontend", "task-2", [
      { path: "repoA/out.ts", content: "assumed no contract", based_on: null },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.moved).toEqual([
      { path: "shared/contract.md", had: 0, now: 1 },
    ]);
  });

  it("reports a missing file rather than inventing a version", async () => {
    const { files } = await createStore();
    expect(await files.fetch("agent-1", "repoA/nope.ts")).toEqual({
      ok: false,
      code: "NOT_FOUND",
      path: "repoA/nope.ts",
    });
  });

  it("rejects paths that could escape a repository prefix", async () => {
    const { files } = await createStore();

    for (const bad of ["../etc/passwd", "/etc/passwd", "repoA/../../secret", "repoA\\win.ts", "  "]) {
      await expect(files.fetch("agent-1", bad)).rejects.toThrow();
    }
    await expect(
      files.commit("agent-1", "task-1", [
        { path: "repoA/a.ts", content: "x", based_on: null },
        { path: "repoA/a.ts", content: "y", based_on: null },
      ]),
    ).rejects.toThrow(/Duplicate path/);
  });

  it("records an ordered event for each commit outcome", async () => {
    const { store, files } = await createStore();
    await seedFile(store, "repoA/orders.ts", "original");

    await files.commit("agent-1", "task-1", [
      { path: "repoA/orders.ts", content: "rejected", based_on: 9 },
    ]);
    await files.commit("agent-1", "task-1", [
      { path: "repoA/orders.ts", content: "accepted", based_on: 1 },
    ]);

    const events = store.snapshot().events;
    expect(events.map((event) => [event.seq, event.type, event.taskId])).toEqual([
      [1, "commit_rejected", "task-1"],
      [2, "commit_ok", "task-1"],
    ]);
  });

  it("loads a database written before the coordination tables existed", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, agents: [], messages: [], runs: [] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.files).toEqual({});
    expect(database.reads).toEqual({});
    expect(database.events).toEqual([]);
    expect(database.eventSeq).toBe(0);

    const files = new FileStore(store);
    const result = await files.commit("agent-1", "task-1", [
      { path: "repoA/first.ts", content: "hello", based_on: null },
    ]);
    expect(result).toEqual({ ok: true, kind: "committed", versions: { "repoA/first.ts": 1 } });
  });
});
