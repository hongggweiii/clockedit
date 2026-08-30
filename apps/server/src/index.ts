import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { FileStore } from "./storage/file-store.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { createRouter, placeholderCoordinator } from "./router/router.js";
import { createTaskServerApp } from "./task-server/app.js";
import {
  Coordinator,
  NoopPushAdapter,
  TaskStore,
} from "./task-server/index.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

// Task-server core: brain + storage + dispatch stub. Shared by both HTTP
// surfaces via the Router.
const taskStore = new TaskStore(store);
const fileStore = new FileStore(store);
const pushAdapter = new NoopPushAdapter();
const coordinator = new Coordinator({ store, taskStore, fileStore, pushAdapter });

// Router validates envelopes and dispatches to Coordinator's on* methods.
// AgentService registers/updates/unregisters agents with the router as they
// are created/updated/deleted, so no manual sync is needed here.
const router = createRouter(placeholderCoordinator);

const service = new AgentService(config, store, workspaces, runner, router, {
  baseUrl: config.taskServerBaseUrl,
  projectId: config.runtimeInstanceId,
  taskId: null,
  ...(config.taskServerAuthToken ? { authToken: config.taskServerAuthToken } : {}),
});
await service.initialize();


const app = await createApp(config, service, router);
const taskServer = await createTaskServerApp(config, router);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await Promise.allSettled([app.close(), taskServer.close()]);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
await taskServer.listen({ host: config.taskServerHost, port: config.taskServerPort });
