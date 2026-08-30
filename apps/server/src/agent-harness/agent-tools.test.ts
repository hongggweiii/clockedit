import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { requestSchema } from "../router/schemas/router.schemas.js";
import type { RunnerRequest } from "../types.js";
import {
  assertCoordinationDone,
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
    expect(JSON.parse(await readFile(
      path.join(workspace, ".coordination", "request-schema.json"),
      "utf8",
    ))).toEqual(z.toJSONSchema(requestSchema));
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
    const prompt = promptWithCoordinationTools(request);
    expect(prompt).toContain(
      "node .coordination/agentctl.mjs list-files",
    );
    expect(prompt).toContain(
      "node .coordination/agentctl.mjs fetch <path>",
    );
    expect(prompt).toContain("mark-edited <path>");
    expect(prompt).toContain("submits every tracked edited file");
    expect(prompt).toContain("create-tasks <json-file>");
    expect(prompt).toContain("using an available Agent id as `owner`");
    expect(prompt).toContain("save that array to the workspace path represented by `<json-file>`");
    expect(prompt).toContain("even when there were no files to commit");
    expect(prompt).not.toContain("agentctl.mjs claim");
    expect(prompt).not.toContain("agentctl.mjs intent");
    const { coordination: _coordination, ...plain } = request;
    expect(promptWithCoordinationTools(plain)).toBe(request.prompt);
  });

  it("requires a successful done marker before a coordinated task completes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "agent-tools-done-"));
    temporaryDirectories.push(workspace);
    const request = { ...coordinatedRequest(), workspacePath: workspace };

    await expect(assertCoordinationDone(request)).rejects.toThrow(/without.*done/s);
    await mkdir(path.join(workspace, ".coordination"));
    await writeFile(
      path.join(workspace, ".coordination", "state.json"),
      JSON.stringify({ versions: {}, edited: [], doneTaskId: "frontend-button" }),
      "utf8",
    );
    await expect(assertCoordinationDone(request)).resolves.toBeUndefined();
    await expect(assertCoordinationDone({
      ...request,
      coordination: { ...request.coordination, taskId: "task-2" },
    })).rejects.toThrow(/without.*done/s);
  });
});
