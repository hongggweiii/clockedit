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
      if (body.kind === "fetch") {
        result = {
          ok: true,
          kind: "file",
          path: body.path,
          version: body.path.startsWith("contracts/") ? 2 : 3,
          content: body.path.startsWith("contracts/") ? "{\"field\":\"order_id\"}" : "old",
          next: "Use this version when committing.",
        };
      } else if (body.kind === "commit") {
        result = {
          ok: true,
          kind: "committed",
          versions: Object.fromEntries(body.writes.map((write) => [write.path, 4])),
          next: "Report the task as done.",
        };
      } else if (body.kind === "claim") {
        result = {
          ok: true,
          kind: "claimed",
          task: {
            id: "frontend-button",
            detail: "Build the button",
            state: "assigned",
            owner: "frontend",
            depends_on: [],
            writes: ["src/App.tsx"],
            strikes: 0,
          },
          next: "Declare intent.",
        };
      } else if (body.kind === "intent") {
        result = { ok: true, kind: "intent_accepted", writes: body.writes, next: "Fetch files." };
      } else if (body.kind === "heartbeat") {
        result = { ok: true, kind: "heartbeat", next: "Continue." };
      } else if (body.kind === "inbox") {
        result = { ok: true, kind: "inbox", tasks: [], events: [], next: "Wait for work." };
      } else if (body.kind === "done") {
        result = { ok: true, kind: "done", task_id: "frontend-button", next: "Wait for work." };
      } else {
        result = { ok: true, kind: "tasks_created", tasks: [], next: "Dispatch tasks." };
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

  it("fetches tracked files and commits writes with read evidence", async () => {
    await run("fetch", "contracts/order-api.json");
    await run("fetch", "src/App.tsx");
    expect(await readFile(path.join(workspace, "contracts", "order-api.json"), "utf8"))
      .toBe('{"field":"order_id"}');
    await writeFile(path.join(workspace, "src", "App.tsx"), "updated", "utf8");

    const committed = await run("commit", "src/App.tsx");
    expect(JSON.parse(committed.stdout)).toMatchObject({
      ok: true,
      kind: "committed",
      versions: { "src/App.tsx": 4 },
    });

    const commitEnvelope = received.find((envelope) => envelope.body.kind === "commit");
    expect(commitEnvelope?.task_id).toBe("frontend-button");
    expect(commitEnvelope?.body).toEqual({
      kind: "commit",
      writes: [{ path: "src/App.tsx", content: "updated", based_on: 3 }],
      reads: [{ path: "contracts/order-api.json", version: 2 }],
    });
    expect(JSON.parse(await readFile(
      path.join(workspace, ".coordination", "state.json"),
      "utf8",
    ))).toMatchObject({ versions: { "src/App.tsx": 4 } });
  });

  it("rejects paths that escape the workspace before sending a message", async () => {
    await expect(run("fetch", "../secret.txt")).rejects.toMatchObject({ code: 1 });
    expect(received).toHaveLength(0);
  });

  it("uses task-scoped envelopes for lifecycle commands", async () => {
    await run("claim");
    await run("intent", "src/App.tsx");
    await run("heartbeat");
    await run("inbox");
    await run("done");

    expect(received.map((envelope) => [envelope.body.kind, envelope.task_id])).toEqual([
      ["claim", "frontend-button"],
      ["intent", "frontend-button"],
      ["heartbeat", "frontend-button"],
      ["inbox", "frontend-button"],
      ["done", "frontend-button"],
    ]);
  });
});
