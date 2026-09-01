import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const demoFiles = () => ({
  "repoA/src/App.tsx": {
    path: "repoA/src/App.tsx",
    version: 1,
    content: [
      'export function App() {',
      '  return <main>Order dashboard</main>;',
      '}',
      '',
    ].join("\n"),
    updatedBy: "system",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  "repoB/src/api/orders.ts": {
    path: "repoB/src/api/orders.ts",
    version: 1,
    content: [
      'export function getOrder(id: string) {',
      '  return { order_id: id, status: "processing" };',
      '}',
      '',
    ].join("\n"),
    updatedBy: "system",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  "shared/order-api.contract.md": {
    path: "shared/order-api.contract.md",
    version: 1,
    content: [
      "# Order API contract",
      "",
      "`GET /orders/:id` returns `order_id` and `status`.",
      "",
    ].join("\n"),
    updatedBy: "system",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
});

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  files: demoFiles(),
  reads: {},
  events: [],
  eventSeq: 0,
  tasks: [],
});

const withDefaults = (parsed: Database): Database => ({
  ...emptyDatabase(),
  ...parsed,
  files: { ...demoFiles(), ...(parsed.files ?? {}) },
  reads: parsed.reads ?? {},
  events: parsed.events ?? [],
  eventSeq: parsed.eventSeq ?? 0,
  tasks: parsed.tasks ?? [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = withDefaults(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
