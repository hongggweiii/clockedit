import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { FileStore } from "./storage/file-store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { createRouter } from "./router/router.js";
import { createTaskServerApp } from "./task-server/app.js";
import {
  Coordinator,
  SseBroadcastAdapter,
  TaskStore,
  type InternalTask,
} from "./task-server/index.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

// Task-server core: brain + storage + real broadcast push adapter.
const taskStore = new TaskStore(store);
const fileStore = new FileStore(store);
const pushAdapter = new SseBroadcastAdapter();
const coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });

// Router validates envelopes and dispatches to Coordinator's on* methods.
// AgentService registers/updates/unregisters agents with the router as they
// are created/updated/deleted, so no manual sync is needed here.
const router = createRouter(coordinator);

const service = new AgentService(config, store, workspaces, runner, router, {
  baseUrl: config.taskServerBaseUrl,
  projectId: config.runtimeInstanceId,
  taskId: null,
  ...(config.taskServerAuthToken ? { authToken: config.taskServerAuthToken } : {}),
});
await service.initialize();

// In-process subscriber: when the Coordinator pushes a task_assigned event,
// spawn Codex for the owner agent via the Playground path. Fire-and-forget
// so the broadcaster is never blocked by Codex boot time.
pushAdapter.subscribe((event) => {
  if (event.kind !== "task_assigned") return;
  const { task } = event;
  if (!task.owner) return;
  void service
    .sendMessage(task.owner, buildTaskPrompt(task), task.id)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dispatch] task=${task.id} owner=${task.owner} failed: ${message}`);
    });
});

function buildTaskPrompt(
  task: InternalTask | { id: string; detail: string; writes: readonly string[]; depends_on: readonly string[] },
): string {
  const writes = task.writes.length > 0 ? `\nExpected to write: ${task.writes.join(", ")}` : "";
  const deps = task.depends_on.length > 0 ? `\nUpstream tasks (already done): ${task.depends_on.join(", ")}` : "";
  return [
    `You have been assigned task ${task.id}.`,
    "",
    task.detail,
    writes,
    deps,
    "",
    "Use agentctl to fetch files, mark-edited, commit, and done.",
  ].filter(Boolean).join("\n");
}

// Public HTTP surface: frontend + Playground + agent CRUD + router activity.
// Router is passed so `GET /api/events?after=N` can serve the activity feed.
const app = await createApp(config, service, router);

// Private HTTP surface: agent-only, bearer-protected on a separate port.
// The broadcast adapter is passed so `GET /events` can stream task_assigned.
const taskServer = await createTaskServerApp(config, router, pushAdapter);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await Promise.allSettled([app.close(), taskServer.close()]);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
await taskServer.listen({ host: config.taskServerHost, port: config.taskServerPort });
