import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { createRouter, placeholderCoordinator } from "./router/router.js";
import { createTaskServerApp } from "./task-server/app.js";
import { TaskStore } from "./task-server/task-store.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const taskStore = new TaskStore(store);
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
// TODO: Replace the placeholder with the task-server Coordinator from the server branch.
const router = createRouter({
  ...placeholderCoordinator,
  listTasks: async () => taskStore.list(),
});
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
  await app.close();
  await taskServer.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
await taskServer.listen({ host: config.taskServerHost, port: config.taskServerPort });
