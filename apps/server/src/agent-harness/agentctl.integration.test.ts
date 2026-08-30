import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../router/router.types.js";
import { envelopeSchema } from "../router/schemas/router.schemas.js";
import { installAgentTools } from "./agent-tools.js";

const execFileAsync = promisify(execFile);

describe("agentctl", () => {
  let workspace: string;
  let toolPath: string;
  let server: Server;
  let baseUrl: string;
  let received: Envelope[];

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "agentctl-"));
    toolPath = await installAgentTools(workspace);
    received = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = envelopeSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      received.push(envelope);
      const body = envelope.body;
      let result: unknown;
      if (body.kind === "list_files") {
        result = {
          ok: true,
          kind: "file_refs",
          files: [
            { path: "contracts/order-api.json", version: 2 },
            { path: "src/App.tsx", version: 3 },
          ],
        };
      } else if (body.kind === "list_agents") {
        result = {
          ok: true,
          kind: "agent_profiles",
          agents: [
            { id: "backend", description: "Owns APIs" },
            { id: "frontend", description: "" },
          ],
        };
      } else if (body.kind === "fetch") {
        result = {
          ok: true,
          kind: "files",
          files: body.paths.map((requestedPath) => ({
            path: requestedPath,
            version: requestedPath.startsWith("contracts/") ? 2 : 3,
            content: requestedPath.startsWith("contracts/")
              ? '{"field":"order_id"}'
              : "old",
          })),
        };
      } else {
        result = { ok: true, kind: "committed" };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await rm(workspace, { recursive: true, force: true });
  });

  async function run(...args: string[]) {
    return execFileAsync(process.execPath, [toolPath, ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        COORDINATION_BASE_URL: baseUrl,
        COORDINATION_PROJECT_ID: "cancel-order",
        COORDINATION_AGENT_ID: "frontend",
        COORDINATION_TASK_ID: "frontend-button",
      },
    });
  }

  it("fetches dependencies and commits every tracked edited file", async () => {
    await run("fetch", "contracts/order-api.json", "src/App.tsx");
    expect(received[0]?.body).toEqual({
      kind: "fetch",
      paths: ["contracts/order-api.json", "src/App.tsx"],
    });
    expect(await readFile(path.join(workspace, "contracts/order-api.json"), "utf8"))
      .toBe('{"field":"order_id"}');
    expect(await readFile(path.join(workspace, "src/App.tsx"), "utf8"))
      .toBe("old");
    await writeFile(path.join(workspace, "src", "App.tsx"), "updated", "utf8");
    await writeFile(path.join(workspace, "new.ts"), "created", "utf8");
    await run("mark-edited", "src/App.tsx", "new.ts");

    const committed = await run("commit");
    expect(JSON.parse(committed.stdout)).toEqual({ ok: true, kind: "committed" });

    const commitEnvelope = received.find((envelope) => envelope.body.kind === "commit");
    expect(commitEnvelope?.task_id).toBe("frontend-button");
    expect(commitEnvelope?.body).toEqual({
      kind: "commit",
      writes: [
        { path: "new.ts", content: "created", based_on: null },
        { path: "src/App.tsx", content: "updated", based_on: 3 },
      ],
      reads: [{ path: "contracts/order-api.json", version: 2 }],
    });
    expect(JSON.parse(await readFile(
      path.join(workspace, ".coordination", "state.json"),
      "utf8",
    ))).toEqual({ versions: {}, edited: [], doneTaskId: null });
  });

  it("discovers paths without fetching contents or creating local state", async () => {
    const listed = await run("list-files");
    expect(JSON.parse(listed.stdout)).toEqual({
      ok: true,
      kind: "file_refs",
      files: [
        { path: "contracts/order-api.json", version: 2 },
        { path: "src/App.tsx", version: 3 },
      ],
    });
    expect(received.at(-1)?.body).toEqual({ kind: "list_files" });
    await expect(readFile(
      path.join(workspace, ".coordination", "state.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers registered agents and their responsibilities", async () => {
    const listed = await run("list-agents");
    expect(JSON.parse(listed.stdout)).toEqual({
      ok: true,
      kind: "agent_profiles",
      agents: [
        { id: "backend", description: "Owns APIs" },
        { id: "frontend", description: "" },
      ],
    });
    expect(received.at(-1)?.body).toEqual({ kind: "list_agents" });
  });

  it("submits owner-aware tasks from the instructed JSON file", async () => {
    const tasks = [{
      id: "backend-contract",
      detail: "Update the API contract",
      owner: "backend",
      depends_on: [],
      writes: ["contracts/order-api.json"],
    }];
    await writeFile(path.join(workspace, "tasks.json"), JSON.stringify(tasks), "utf8");
    await run("create-tasks", "tasks.json");
    expect(received.at(-1)?.body).toEqual({ kind: "create_tasks", tasks });
  });

  it("builds requests through the installed runtime schema", async () => {
    const schemaPath = path.join(workspace, ".coordination", "request-schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      oneOf: Array<{ properties?: { kind?: { const?: string } } }>;
    };
    schema.oneOf = schema.oneOf.filter(
      (variant) => variant.properties?.kind?.const !== "list_files",
    );
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");

    await expect(run("list-files")).rejects.toMatchObject({ code: 1 });
    expect(received).toHaveLength(0);
  });

  it("rejects task JSON that does not match the installed task request schema", async () => {
    await writeFile(
      path.join(workspace, "invalid-tasks.json"),
      JSON.stringify([{
        id: "backend-contract",
        detail: "Update the API contract",
        depends_on: [],
        writes: ["contracts/order-api.json"],
      }]),
      "utf8",
    );

    await expect(run("create-tasks", "invalid-tasks.json")).rejects.toMatchObject({ code: 1 });
    expect(received).toHaveLength(0);
  });

  it("reports done even when no files were edited", async () => {
    await run("done");
    expect(received.at(-1)).toMatchObject({
      task_id: "frontend-button",
      body: { kind: "done" },
    });
    expect(JSON.parse(await readFile(
      path.join(workspace, ".coordination", "state.json"),
      "utf8",
    ))).toEqual({ versions: {}, edited: [], doneTaskId: "frontend-button" });
  });

  it("rejects removed pull-model commands without sending messages", async () => {
    for (const command of ["claim", "intent", "heartbeat", "inbox"]) {
      await expect(run(command)).rejects.toMatchObject({ code: 1 });
    }
    expect(received).toHaveLength(0);
  });

  it("rejects paths that escape the workspace before sending a message", async () => {
    await expect(run("fetch", "../secret.txt")).rejects.toMatchObject({ code: 1 });
    expect(received).toHaveLength(0);
  });
});
