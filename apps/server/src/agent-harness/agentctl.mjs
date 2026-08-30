#!/usr/bin/env node
// @ts-check

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCommitRequest,
  buildCreateTasksRequest,
  buildDoneRequest,
  buildEnvelope,
  buildFetchRequest,
  buildListFilesRequest,
} from "../router/request-builders.js";

/** @typedef {import("../router/router.types.js").Request} Request */
/** @typedef {import("../router/router.types.js").CommitRequest["writes"]} FileWrites */
/** @typedef {import("../router/router.types.js").CreateTasksRequest["tasks"]} NewTasks */
/** @typedef {{ versions: Record<string, number>, edited: string[], doneTaskId: string | null }} CoordinationState */
/** @typedef {{ ok: boolean, [key: string]: any }} ProtocolResponse */

const stateDirectoryName = ".coordination";
const stateFileName = "state.json";

/**
 * @param {string} message
 * @param {unknown} [detail]
 * @param {number} [code]
 * @returns {never}
 */
function exitWithError(message, detail, code = 1) {
  process.stderr.write(JSON.stringify({ ok: false, error: message, detail }) + "\n");
  process.exit(code);
}

/** @param {string} name */
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) exitWithError(`${name} is required`);
  return value;
}

/** @param {unknown} error */
function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {string} value */
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

/** @param {string[]} values */
function uniquePaths(values) {
  const paths = values.map(normalizeProtocolPath);
  if (new Set(paths).size !== paths.length) {
    exitWithError("Each file path may be provided only once", paths);
  }
  return paths;
}

/** @param {string} protocolPath */
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

/** @returns {CoordinationState} */
function emptyState() {
  return { versions: Object.create(null), edited: [], doneTaskId: null };
}

/** @returns {Promise<CoordinationState>} */
async function readState() {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(statePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid state shape");
    const candidate = /** @type {{ versions?: unknown, edited?: unknown, doneTaskId?: unknown }} */ (parsed);
    if (!candidate.versions || typeof candidate.versions !== "object") {
      throw new Error("Invalid state versions");
    }
    /** @type {Record<string, number>} */
    const versions = Object.create(null);
    for (const [filePath, version] of Object.entries(candidate.versions)) {
      normalizeProtocolPath(filePath);
      if (!Number.isInteger(version) || /** @type {number} */ (version) < 0) {
        throw new Error("Invalid file version");
      }
      versions[filePath] = /** @type {number} */ (version);
    }
    const edited = candidate.edited === undefined ? [] : candidate.edited;
    if (!Array.isArray(edited) || edited.some((value) => typeof value !== "string")) {
      throw new Error("Invalid edited file list");
    }
    const normalizedEdited = uniquePaths(/** @type {string[]} */ (edited));
    if (
      candidate.doneTaskId !== undefined &&
      candidate.doneTaskId !== null &&
      typeof candidate.doneTaskId !== "string"
    ) {
      throw new Error("Invalid done task id");
    }
    return {
      versions,
      edited: normalizedEdited,
      doneTaskId: typeof candidate.doneTaskId === "string"
        ? candidate.doneTaskId
        : null,
    };
  } catch (error) {
    if (isMissingFile(error)) return emptyState();
    exitWithError("Unable to read coordination state", error instanceof Error ? error.message : String(error));
  }
}

/** @param {CoordinationState} state */
async function writeState(state) {
  const directory = path.dirname(statePath());
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${stateFileName}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(temporary, statePath());
}

/** @param {boolean} required */
function taskId(required) {
  const value = process.env.COORDINATION_TASK_ID?.trim() || null;
  if (required && !value) exitWithError("COORDINATION_TASK_ID is required for this command");
  return value;
}

/**
 * @template TValue
 * @param {() => TValue} build
 * @returns {TValue}
 */
function buildRequest(build) {
  try {
    return build();
  } catch (error) {
    exitWithError(
      "Unable to build request from the router schema",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Outgoing bodies are built with the schemas compiled from router/schemas
 * and are also checked during the server typecheck.
 * @param {Request} body
 * @param {boolean} [requiresTask]
 * @returns {Promise<ProtocolResponse>}
 */
async function send(body, requiresTask = false) {
  const baseUrl = requiredEnvironment("COORDINATION_BASE_URL");
  const projectId = requiredEnvironment("COORDINATION_PROJECT_ID");
  const agent = requiredEnvironment("COORDINATION_AGENT_ID");
  const endpoint = new URL(
    `api/projects/${encodeURIComponent(projectId)}/coordination/messages`,
    baseUrl.endsWith("/") ? baseUrl : baseUrl + "/",
  );
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  const authToken = process.env.COORDINATION_AUTH_TOKEN?.trim();
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const envelope = buildRequest(
    () => buildEnvelope(randomUUID(), agent, taskId(requiresTask), body),
  );

  /** @type {globalThis.Response} */
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    exitWithError("Unable to reach the coordination server", error instanceof Error ? error.message : String(error));
  }

  const text = await response.text();
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    exitWithError("Coordination server returned invalid JSON", { status: response.status, body: text });
  }
  if (!response.ok) {
    exitWithError("Coordination server rejected the HTTP request", { status: response.status, response: payload });
  }
  if (!payload || typeof payload !== "object" || !("ok" in payload) || typeof payload.ok !== "boolean") {
    exitWithError("Coordination server returned an invalid protocol response", payload);
  }
  const protocolResponse = /** @type {ProtocolResponse} */ (payload);
  if (!protocolResponse.ok) {
    process.stderr.write(JSON.stringify(protocolResponse, null, 2) + "\n");
    process.exit(2);
  }
  return protocolResponse;
}

/** @param {ProtocolResponse} response @param {string} kind */
function expectResponseKind(response, kind) {
  if (response.kind !== kind) {
    exitWithError(`Expected a ${kind} response`, response);
  }
  return response;
}

/** @param {string[]} args */
async function listFiles(args) {
  if (args.length !== 0) exitWithError("Usage: agentctl list-files");
  const request = buildRequest(buildListFilesRequest);
  const response = await send(request);
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

/** @param {string[]} args */
async function fetchFile(args) {
  if (args.length !== 1) exitWithError("Usage: agentctl fetch <path>");
  const requestedPath = normalizeProtocolPath(args[0] ?? "");
  const request = buildRequest(() => buildFetchRequest([requestedPath]));
  const response = await send(request);
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
  state.edited = state.edited.filter((filePath) => filePath !== requestedPath);
  state.doneTaskId = null;
  await writeState(state);
  return response;
}

/** @param {string[]} args */
async function markEdited(args) {
  if (args.length === 0) exitWithError("Usage: agentctl mark-edited <path> [path ...]");
  const paths = uniquePaths(args);
  paths.forEach(workspacePath);
  const state = await readState();
  state.edited = [...new Set([...state.edited, ...paths])].sort();
  state.doneTaskId = null;
  await writeState(state);
  return { ok: true, kind: "edited_tracked", paths: state.edited };
}

/** @param {string[]} args */
async function commit(args) {
  if (args.length !== 0) exitWithError("Usage: agentctl commit");
  const state = await readState();
  if (state.edited.length === 0) {
    exitWithError("No edited files are tracked; use mark-edited after changing a file");
  }
  /** @type {FileWrites} */
  const writes = [];
  for (const filePath of state.edited) {
    try {
      writes.push({
        path: filePath,
        content: await readFile(workspacePath(filePath), "utf8"),
        based_on: state.versions[filePath] ?? null,
      });
    } catch (error) {
      if (isMissingFile(error) && state.versions[filePath] !== undefined) {
        writes.push({
          path: filePath,
          content: "",
          based_on: state.versions[filePath],
          delete: true,
        });
        continue;
      }
      exitWithError("Unable to read a tracked edited file", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const written = new Set(state.edited);
  const reads = Object.entries(state.versions)
    .filter(([filePath]) => !written.has(filePath))
    .map(([filePath, version]) => ({ path: filePath, version }));
  const request = buildRequest(() => buildCommitRequest(writes, reads));
  const response = expectResponseKind(await send(request), "committed");
  state.versions = Object.create(null);
  state.edited = [];
  state.doneTaskId = null;
  await writeState(state);
  return response;
}

/** @param {string[]} args */
async function createTasks(args) {
  if (args.length !== 1) exitWithError("Usage: agentctl create-tasks <json-file>");
  const inputPath = normalizeProtocolPath(args[0] ?? "");
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(workspacePath(inputPath), "utf8"));
  } catch (error) {
    exitWithError("Unable to read task JSON", error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(parsed)) exitWithError("Task JSON must contain an array");
  const tasks = /** @type {NewTasks} */ (parsed);
  const request = buildRequest(() => buildCreateTasksRequest(tasks));
  return send(request);
}

/** @param {string[]} args */
async function done(args) {
  if (args.length !== 0) exitWithError("Usage: agentctl done");
  const request = buildRequest(buildDoneRequest);
  const response = await send(request, true);
  const state = await readState();
  state.doneTaskId = taskId(true);
  await writeState(state);
  return response;
}

function usage() {
  return [
    "Usage: agentctl <command>",
    "",
    "Commands:",
    "  list-files",
    "  fetch <path>",
    "  mark-edited <path> [path ...]",
    "  commit",
    "  create-tasks <json-file>",
    "  done",
  ].join("\n");
}

const [command, ...args] = process.argv.slice(2);
let result;
switch (command) {
  case "list-files":
    result = await listFiles(args);
    break;
  case "fetch":
    result = await fetchFile(args);
    break;
  case "mark-edited":
    result = await markEdited(args);
    break;
  case "commit":
    result = await commit(args);
    break;
  case "create-tasks":
    result = await createTasks(args);
    break;
  case "done":
    result = await done(args);
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(usage() + "\n");
    process.exit(0);
  default:
    process.stderr.write(usage() + "\n");
    process.exit(1);
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
