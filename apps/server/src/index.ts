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
  LocalDispatchPushAdapter,
  TaskStore,
} from "./task-server/index.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

// Task-server core: DAG + state machine + OCC policy.
const taskStore = new TaskStore(store);
const fileStore = new FileStore(store);

// Push adapter is created first (unbound). The Coordinator uses it to spawn
// Codex when a task is assigned. The AgentService is bound to it after init.
const pushAdapter = new LocalDispatchPushAdapter();
const coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });

// Router validates envelopes + dispatches to Coordinator's on* methods.
// AgentService owns agent-channel registration lifecycle via SSE.
const router = createRouter(coordinator);

const service = new AgentService(config, store, workspaces, runner, router, {
  baseUrl: config.taskServerBaseUrl,
  ...(config.taskServerRuntimeBaseUrl
    ? { runtimeBaseUrl: config.taskServerRuntimeBaseUrl }
    : {}),
  projectId: config.runtimeInstanceId,
  taskId: null,
  ...(config.taskServerAuthToken ? { authToken: config.taskServerAuthToken } : {}),
});
await service.initialize();

// Close the loop: pushAdapter now knows how to spawn Codex for a task's owner.
pushAdapter.bind(service);

// Public HTTP surface: frontend + Playground + agent CRUD + router activity + task DAG.
// Router serves `GET /api/events?after=N`. Coordinator serves `POST/GET /api/tasks`.
const app = await createApp(config, service, router, coordinator);

// Private HTTP surface: agent-facing SSE + protocol. `GET /events?agent_id=X`
// opens a per-agent SseAgentChannel; AgentService is the loopback client.
const taskServer = await createTaskServerApp(config, router, (agentId) =>
  service.getAgentProfile(agentId),
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await Promise.allSettled([app.close(), taskServer.close()]);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
await taskServer.listen({ host: config.taskServerHost, port: config.taskServerPort });

// After both listeners are up, reconnect SSE channels for any pre-existing
// agents so they can receive dispatched messages from the router.
await service.connectInitializedAgents();
