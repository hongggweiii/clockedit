#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const stateDirectoryName = ".coordination";
const stateFileName = "state.json";

function exitWithError(message, detail, code = 1) {
  process.stderr.write(JSON.stringify({ ok: false, error: message, detail }) + "\n");
  process.exit(code);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) exitWithError(`${name} is required`);
  return value;
}

function normalizeProtocolPath(value) {
  const candidate = value.trim();
  if (!candidate) exitWithError("File path must not be empty");
  if (candidate.includes("\\")) {
    exitWithError("File paths must use forward slashes", candidate);
  }
  if (candidate.startsWith("/")) {
    exitWithError("File paths must be relative", candidate);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    exitWithError("File paths must not contain empty or relative segments", candidate);
  }
  if (segments[0] === stateDirectoryName) {
    exitWithError(`${stateDirectoryName} is reserved for coordination state`, candidate);
  }
  return candidate;
}

function uniquePaths(values) {
  const paths = values.map(normalizeProtocolPath);
  if (new Set(paths).size !== paths.length) {
    exitWithError("Each file path may be provided only once", paths);
  }
  return paths;
}

function workspacePath(protocolPath) {
  const root = path.resolve(process.cwd());
  const resolved = path.resolve(root, ...protocolPath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    exitWithError("File path escapes the Agent workspace", protocolPath);
  }
  return resolved;
}

function statePath() {
  return path.join(process.cwd(), stateDirectoryName, stateFileName);
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.versions || typeof parsed.versions !== "object") {
      throw new Error("Invalid state shape");
    }
    for (const [filePath, version] of Object.entries(parsed.versions)) {
      normalizeProtocolPath(filePath);
      if (!Number.isInteger(version) || version < 0) throw new Error("Invalid file version");
    }
    return { versions: Object.assign(Object.create(null), parsed.versions) };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { versions: Object.create(null) };
    }
    exitWithError("Unable to read coordination state", error instanceof Error ? error.message : String(error));
  }
}

async function writeState(state) {
  const directory = path.dirname(statePath());
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${stateFileName}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(temporary, statePath());
}

function taskId(required) {
  const value = process.env.COORDINATION_TASK_ID?.trim() || null;
  if (required && !value) exitWithError("COORDINATION_TASK_ID is required for this command");
  return value;
}

async function send(body, requiresTask = false) {
  const baseUrl = requiredEnvironment("COORDINATION_BASE_URL");
  const projectId = requiredEnvironment("COORDINATION_PROJECT_ID");
  const agent = requiredEnvironment("COORDINATION_AGENT_ID");
  const endpoint = new URL(
    `api/projects/${encodeURIComponent(projectId)}/coordination/messages`,
    baseUrl.endsWith("/") ? baseUrl : baseUrl + "/",
  );
  const headers = { "content-type": "application/json" };
  const authToken = process.env.COORDINATION_AUTH_TOKEN?.trim();
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        msg_id: randomUUID(),
        agent,
        task_id: taskId(requiresTask),
        body,
      }),
    });
  } catch (error) {
    exitWithError("Unable to reach the coordination server", error instanceof Error ? error.message : String(error));
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    exitWithError("Coordination server returned invalid JSON", { status: response.status, body: text });
  }
  if (!response.ok) {
    exitWithError("Coordination server rejected the HTTP request", { status: response.status, response: payload });
  }
  if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
    exitWithError("Coordination server returned an invalid protocol response", payload);
  }
  if (!payload.ok) {
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(2);
  }
  return payload;
}

function expectResponseKind(response, kind) {
  if (response.kind !== kind) {
    exitWithError(`Expected a ${kind} response`, response);
  }
  return response;
}

async function claim(args) {
  if (args.length > 0) exitWithError("Usage: agentctl claim");
  return expectResponseKind(await send({ kind: "claim" }, true), "claimed");
}

async function intent(args) {
  if (args.length === 0) exitWithError("Usage: agentctl intent <path> [path ...]");
  return expectResponseKind(
    await send({ kind: "intent", writes: uniquePaths(args) }, true),
    "intent_accepted",
  );
}

async function fetchFile(args) {
  if (args.length !== 1) exitWithError("Usage: agentctl fetch <path>");
  const requestedPath = normalizeProtocolPath(args[0]);
  const response = await send({ kind: "fetch", path: requestedPath });
  if (
    response.kind !== "file" ||
    response.path !== requestedPath ||
    !Number.isInteger(response.version) ||
    response.version < 0 ||
    typeof response.content !== "string"
  ) {
    exitWithError("Fetch returned an invalid file response", response);
  }
  const destination = workspacePath(requestedPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, response.content, "utf8");
  const state = await readState();
  state.versions[requestedPath] = response.version;
  await writeState(state);
  return response;
}

async function listFiles(args) {
  if (args.length !== 0) exitWithError("Usage: agentctl list-files");
  const response = await send({ kind: "list_files" });
  if (response.kind !== "files" || !Array.isArray(response.files)) {
    exitWithError("List files returned an invalid response", response);
  }
  const paths = new Set();
  for (const file of response.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string") {
      exitWithError("List files returned an invalid file reference", file);
    }
    const filePath = normalizeProtocolPath(file.path);
    if (paths.has(filePath) || !Number.isInteger(file.version) || file.version < 0) {
      exitWithError("List files returned an invalid file reference", file);
    }
    paths.add(filePath);
  }
  return response;
}

async function commit(args) {
  if (args.length === 0) exitWithError("Usage: agentctl commit <path> [path ...]");
  const paths = uniquePaths(args);
  const state = await readState();
  const writes = [];
  for (const filePath of paths) {
    let content;
    try {
      content = await readFile(workspacePath(filePath), "utf8");
    } catch (error) {
      exitWithError("Unable to read a file selected for commit", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    writes.push({
      path: filePath,
      content,
      based_on: state.versions[filePath] ?? null,
    });
  }
  const written = new Set(paths);
  const reads = Object.entries(state.versions)
    .filter(([filePath]) => !written.has(filePath))
    .map(([filePath, version]) => ({ path: filePath, version }));
  const response = await send({ kind: "commit", writes, reads }, true);
  if (response.kind !== "committed" || !response.versions || typeof response.versions !== "object") {
    exitWithError("Commit returned an invalid response", response);
  }
  for (const [filePath, version] of Object.entries(response.versions)) {
    const normalized = normalizeProtocolPath(filePath);
    if (!Number.isInteger(version) || version < 0) {
      exitWithError("Commit returned an invalid version", { path: normalized, version });
    }
    state.versions[normalized] = version;
  }
  await writeState(state);
  return response;
}

async function createTasks(args) {
  if (args.length !== 1) exitWithError("Usage: agentctl create-tasks <json-file>");
  const inputPath = normalizeProtocolPath(args[0]);
  let tasks;
  try {
    tasks = JSON.parse(await readFile(workspacePath(inputPath), "utf8"));
  } catch (error) {
    exitWithError("Unable to read task JSON", error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(tasks)) exitWithError("Task JSON must contain an array");
  return expectResponseKind(await send({ kind: "create_tasks", tasks }), "tasks_created");
}

function usage() {
  return [
    "Usage: agentctl <command>",
    "",
    "Commands:",
    "  claim",
    "  intent <path> [path ...]",
    "  list-files",
    "  fetch <path>",
    "  commit <path> [path ...]",
    "  heartbeat",
    "  inbox",
    "  done",
    "  create-tasks <json-file>",
  ].join("\n");
}

const [command, ...args] = process.argv.slice(2);
let result;
switch (command) {
  case "claim":
    result = await claim(args);
    break;
  case "intent":
    result = await intent(args);
    break;
  case "fetch":
    result = await fetchFile(args);
    break;
  case "list-files":
    result = await listFiles(args);
    break;
  case "commit":
    result = await commit(args);
    break;
  case "heartbeat":
    if (args.length > 0) exitWithError("Usage: agentctl heartbeat");
    result = expectResponseKind(await send({ kind: "heartbeat" }), "heartbeat");
    break;
  case "inbox":
    if (args.length > 0) exitWithError("Usage: agentctl inbox");
    result = expectResponseKind(await send({ kind: "inbox" }), "inbox");
    break;
  case "done":
    if (args.length > 0) exitWithError("Usage: agentctl done");
    result = expectResponseKind(await send({ kind: "done" }, true), "done");
    break;
  case "create-tasks":
    result = await createTasks(args);
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(usage() + "\n");
    process.exit(0);
    break;
  default:
    process.stderr.write(usage() + "\n");
    process.exit(1);
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
