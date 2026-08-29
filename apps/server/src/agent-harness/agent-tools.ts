import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunnerRequest } from "../types.js";

const toolDirectoryName = ".coordination";
const toolFileName = "agentctl.mjs";
const toolSource = fileURLToPath(new URL("./agentctl.mjs", import.meta.url));

export async function installAgentTools(workspacePath: string): Promise<string> {
  const toolDirectory = path.join(workspacePath, toolDirectoryName);
  await mkdir(toolDirectory, { recursive: true });
  const destination = path.join(toolDirectory, toolFileName);
  await copyFile(toolSource, destination);
  return destination;
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
    "- Use `node .coordination/agentctl.mjs list-files` to discover available shared paths.",
    "- Use `node .coordination/agentctl.mjs intent <path>...` before editing shared files.",
    "- Use `node .coordination/agentctl.mjs fetch <path>` instead of reading shared storage directly.",
    "- Use `node .coordination/agentctl.mjs commit <path>...` to submit completed files.",
    "- If a protocol command fails, read its JSON error and follow the `next` instruction.",
    "- Run `node .coordination/agentctl.mjs done` only after the final commit succeeds.",
  ].join("\n");
}
