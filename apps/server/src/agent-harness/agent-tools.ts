import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerRequest } from "../types.js";

const toolDirectoryName = ".coordination";
const toolFileName = "agentctl.mjs";
const currentModule = fileURLToPath(import.meta.url);
const launcherSource = fileURLToPath(
  new URL("./agentctl-launcher.mjs", import.meta.url),
);
const runtimeSource = fileURLToPath(
  currentModule.endsWith(".ts")
    ? new URL("../../dist/agent-runtime", import.meta.url)
    : new URL("../agent-runtime", import.meta.url),
);
const require = createRequire(import.meta.url);
const zodSource = path.dirname(require.resolve("zod/package.json"));

export const coordinationWorkflowInstructions = [
  "- Use `node .coordination/agentctl.mjs list-files` whenever you need to discover shared files to read or edit.",
  "- Use `node .coordination/agentctl.mjs fetch <path>` before reading or editing a shared file.",
  "- After creating, editing, or deleting a file, immediately run `node .coordination/agentctl.mjs mark-edited <path>...` so every changed path is tracked.",
  "- Before finishing, run `node .coordination/agentctl.mjs commit`; it submits every tracked edited file together.",
  "- If commit reports `STALE`, list and fetch the moved files, reapply the required changes, mark the edited paths, and retry commit.",
  "- If available Agent profiles are provided and another Agent is better suited to a subtask, create a JSON array of tasks with `id`, `detail`, `owner`, `depends_on`, and `writes`, using an available Agent id as `owner`; save that array to the workspace path represented by `<json-file>`, then run `node .coordination/agentctl.mjs create-tasks <json-file>`.",
  "- Always run `node .coordination/agentctl.mjs done` when the task is finished, even when there were no files to commit.",
];

export async function installAgentTools(workspacePath: string): Promise<string> {
  const toolDirectory = path.join(workspacePath, toolDirectoryName);
  await mkdir(toolDirectory, { recursive: true });
  const destination = path.join(toolDirectory, toolFileName);
  const runtimeDestination = path.join(toolDirectory, "runtime");
  await Promise.all([
    copyFile(launcherSource, destination),
    cp(runtimeSource, runtimeDestination, { recursive: true }),
  ]);
  await cp(
    zodSource,
    path.join(runtimeDestination, "node_modules", "zod"),
    { recursive: true },
  );
  return destination;
}

export async function assertCoordinationDone(request: RunnerRequest): Promise<void> {
  if (!request.coordination?.taskId) return;
  const markerPath = path.join(
    request.workspacePath,
    toolDirectoryName,
    "state.json",
  );
  try {
    const state = JSON.parse(await readFile(markerPath, "utf8")) as {
      doneTaskId?: unknown;
    };
    if (state.doneTaskId === request.coordination.taskId) return;
  } catch {
    // The error below gives the Agent-facing action for missing and invalid state.
  }
  throw new Error(
    "Coordinated task finished without `node .coordination/agentctl.mjs done` succeeding",
  );
}

export function coordinationEnvironment(
  request: RunnerRequest,
): NodeJS.ProcessEnv {
  if (!request.coordination) return {};
  return {
    COORDINATION_BASE_URL: request.coordination.baseUrl,
    COORDINATION_PROJECT_ID: request.coordination.projectId,
    COORDINATION_AGENT_ID: request.agentId,
    ...(request.coordination.taskId
      ? { COORDINATION_TASK_ID: request.coordination.taskId }
      : {}),
    ...(request.coordination.authToken
      ? { COORDINATION_AUTH_TOKEN: request.coordination.authToken }
      : {}),
  };
}

export function coordinationContainerEnvArgs(request: RunnerRequest): string[] {
  return Object.keys(coordinationEnvironment(request)).flatMap((name) => [
    "--env",
    name,
  ]);
}

export function promptWithCoordinationTools(request: RunnerRequest): string {
  if (!request.coordination) return request.prompt;
  return [
    request.prompt,
    "",
    "Coordination requirements:",
    ...coordinationWorkflowInstructions,
  ].join("\n");
}
