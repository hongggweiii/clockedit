import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requestSchema } from "../router/schemas/router.schemas.js";
import type { RunnerRequest } from "../types.js";

const toolDirectoryName = ".coordination";
const toolFileName = "agentctl.mjs";
const requestSchemaFileName = "request-schema.json";
const toolSource = fileURLToPath(new URL("./agentctl.mjs", import.meta.url));

const coordinationWorkflowInstructionsBase = [
  "- Use `node .coordination/agentctl.mjs list-files` whenever you need to discover shared files to read or edit.",
  "- Use `node .coordination/agentctl.mjs list-agents` to discover registered Agents and their responsibilities before creating subtasks.",
  "- Use `node .coordination/agentctl.mjs fetch <path> [path ...]` before reading or editing shared files.",
  "- Before editing shared files in a run without an assigned task, create exactly one root task with `owner` set to your Agent id and no dependencies; `agentctl create-tasks` adopts that task for this run.",
  "- If available Agent profiles are provided and another Agent is better suited to a subtask, create a JSON array of tasks with `id`, `detail`, `owner`, `depends_on`, and `writes`, using an available Agent id as `owner`; save that array to the workspace path represented by `<json-file>`, then run `node .coordination/agentctl.mjs create-tasks <json-file>`.",
];

const taskCoordinationWorkflowInstructions = [
  "- After creating, editing, or deleting a file, immediately run `node .coordination/agentctl.mjs mark-edited <path>...` so every changed path is tracked.",
  "- Before finishing, run `node .coordination/agentctl.mjs commit`; it submits every tracked edited file together.",
  "- If commit reports `STALE`, list and fetch the moved files, reapply the required changes, mark the edited paths, and retry commit.",
  "- Always run `node .coordination/agentctl.mjs done` when the assigned task is finished, even when there were no files to commit.",
];

export const coordinationWorkflowInstructions = [
  ...coordinationWorkflowInstructionsBase,
  ...taskCoordinationWorkflowInstructions,
];

export async function installAgentTools(workspacePath: string): Promise<string> {
  const toolDirectory = path.join(workspacePath, toolDirectoryName);
  await mkdir(toolDirectory, { recursive: true });
  const destination = path.join(toolDirectory, toolFileName);
  await Promise.all([
    copyFile(toolSource, destination),
    writeFile(
      path.join(toolDirectory, requestSchemaFileName),
      JSON.stringify(z.toJSONSchema(requestSchema), null, 2) + "\n",
      "utf8",
    ),
  ]);
  return destination;
}

export async function assertCoordinationDone(request: RunnerRequest): Promise<void> {
  let expectedTaskId = request.coordination?.taskId ?? null;
  const markerPath = path.join(
    request.workspacePath,
    toolDirectoryName,
    "state.json",
  );
  try {
    const state = JSON.parse(await readFile(markerPath, "utf8")) as {
      doneTaskId?: unknown;
      activeTaskId?: unknown;
    };
    expectedTaskId ??= typeof state.activeTaskId === "string" ? state.activeTaskId : null;
    if (!expectedTaskId || state.doneTaskId === expectedTaskId) return;
  } catch {
    // The error below gives the Agent-facing action for missing and invalid state.
  }
  if (!expectedTaskId) return;
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
  const environment = coordinationEnvironment(request);
  return Object.entries(environment).flatMap(([name, value]) => {
    // Keep the token out of argv. The runner passes it through the Docker
    // process environment, while the non-secret values are made explicit so
    // they do not depend on the parent shell exporting application config.
    return name === "COORDINATION_AUTH_TOKEN"
      ? ["--env", name]
      : ["--env", `${name}=${value}`];
  });
}

export function promptWithCoordinationTools(request: RunnerRequest): string {
  if (!request.coordination) return request.prompt;
  const workflowInstructions = request.coordination.taskId
    ? coordinationWorkflowInstructions
    : coordinationWorkflowInstructionsBase;
  return [
    request.prompt,
    "",
    "Coordination requirements:",
    ...workflowInstructions,
  ].join("\n");
}
