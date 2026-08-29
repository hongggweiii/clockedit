import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerRequest } from "../types.js";
import {
  coordinationContainerEnvArgs,
  coordinationEnvironment,
  installAgentTools,
  promptWithCoordinationTools,
} from "./agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function coordinatedRequest(): RunnerRequest {
  return {
    agentId: "frontend",
    workspacePath: "/workspace",
    prompt: "Build the cancel button.",
    threadId: null,
    coordination: {
      baseUrl: "http://coordination.test:3000",
      projectId: "cancel-order",
      taskId: "frontend-button",
      authToken: "test-token",
    },
  };
}

describe("Agent coordination tools", () => {
  it("installs the executable client in the Agent workspace", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-tools-"));
    temporaryDirectories.push(workspace);
    const installed = await installAgentTools(workspace);
    expect(installed).toBe(path.join(workspace, ".coordination", "agentctl.mjs"));
    expect(await readFile(installed, "utf8")).toContain("COORDINATION_BASE_URL");
  });

  it("provides scoped context without placing secrets in container arguments", () => {
    const request = coordinatedRequest();
    expect(coordinationEnvironment(request)).toEqual({
      COORDINATION_BASE_URL: "http://coordination.test:3000",
      COORDINATION_PROJECT_ID: "cancel-order",
      COORDINATION_AGENT_ID: "frontend",
      COORDINATION_TASK_ID: "frontend-button",
      COORDINATION_AUTH_TOKEN: "test-token",
    });
    const args = coordinationContainerEnvArgs(request);
    expect(args).toContain("COORDINATION_AUTH_TOKEN");
    expect(args).not.toContain("test-token");
  });

  it("adds tool instructions only to coordinated runs", () => {
    const request = coordinatedRequest();
    expect(promptWithCoordinationTools(request)).toContain(
      "node .coordination/agentctl.mjs list-files",
    );
    expect(promptWithCoordinationTools(request)).toContain(
      "node .coordination/agentctl.mjs fetch <path>",
    );
    const { coordination: _coordination, ...plain } = request;
    expect(promptWithCoordinationTools(plain)).toBe(request.prompt);
  });
});
