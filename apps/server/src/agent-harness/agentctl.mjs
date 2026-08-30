#!/usr/bin/env node
// @ts-check

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {import("../router/router.types.js").Request} Request */
/** @typedef {{ versions: Record<string, number>, edited: string[], doneTaskId: string | null }} CoordinationState */
/** @typedef {{ ok: boolean, [key: string]: any }} ProtocolResponse */

const stateDirectoryName = ".coordination";
const stateFileName = "state.json";
const requestSchemaFileName = "request-schema.json";

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

function requestSchemaPath() {
  return path.join(process.cwd(), stateDirectoryName, requestSchemaFileName);
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the JSON Schema subset emitted by Zod for coordination requests.
 * @param {any} schema
 * @param {any} value
 * @param {string} [location]
 * @returns {string[]}
 */
function jsonSchemaIssues(schema, value, location = "$") {
  if (!isRecord(schema)) return [`${location}: invalid installed schema`];

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      /** @param {any} variant */
      (variant) => jsonSchemaIssues(variant, value, location).length === 0,
    );
    return matches.length === 1
      ? []
      : [`${location}: value must match exactly one request schema`];
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some(
      /** @param {any} variant */
      (variant) => jsonSchemaIssues(variant, value, location).length === 0,
    )
      ? []
      : [`${location}: value does not match an allowed schema`];
  }

  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    return [`${location}: expected ${JSON.stringify(schema.const)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${location}: value is not in the allowed set`];
  }

  if (schema.type === "null") {
    return value === null ? [] : [`${location}: expected null`];
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? [] : [`${location}: expected boolean`];
  }
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return [`${location}: expected integer`];
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return [`${location}: value is below the minimum`];
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return [`${location}: value is above the maximum`];
    }
    return [];
  }
  if (schema.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? []
      : [`${location}: expected number`];
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${location}: expected string`];
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return [`${location}: string is shorter than allowed`];
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return [`${location}: string is longer than allowed`];
    }
    return [];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${location}: expected array`];
    const issues = [];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push(`${location}: array has too few items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push(`${location}: array has too many items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...jsonSchemaIssues(schema.items, item, `${location}[${index}]`));
      });
    }
    return issues;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) return [`${location}: expected object`];
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const issues = [];
    for (const name of required) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) {
        issues.push(`${location}.${name}: required property is missing`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) {
          issues.push(`${location}.${name}: property is not allowed`);
        }
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) {
        issues.push(...jsonSchemaIssues(propertySchema, value[name], `${location}.${name}`));
      }
    }
    return issues;
  }

  return [`${location}: unsupported installed schema`];
}

/**
 * Build a request through the runtime schema generated from router/schemas.
 * @param {unknown} candidate
 * @returns {Promise<Request>}
 */
async function requestFromSchema(candidate) {
  /** @type {unknown} */
  let schema;
  try {
    schema = JSON.parse(await readFile(requestSchemaPath(), "utf8"));
  } catch (error) {
    exitWithError(
      "Unable to read the installed coordination request schema",
      error instanceof Error ? error.message : String(error),
    );
  }
  const issues = jsonSchemaIssues(schema, candidate);
  if (issues.length > 0) {
    exitWithError("Unable to build request from the coordination schema", issues);
  }
  return /** @type {Request} */ (candidate);
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
 * Outgoing bodies are built through the installed runtime schema generated
 * from router/schemas and are also checked during the server typecheck.
 * @param {Request} body
 * @param {boolean} [requiresTask]
 * @returns {Promise<ProtocolResponse>}
 */
async function send(body, requiresTask = false) {
  const baseUrl = requiredEnvironment("COORDINATION_BASE_URL");
  const agent = requiredEnvironment("COORDINATION_AGENT_ID");
  const endpoint = new URL(
    "messages",
    baseUrl.endsWith("/") ? baseUrl : baseUrl + "/",
  );
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  const authToken = process.env.COORDINATION_AUTH_TOKEN?.trim();
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  /** @type {globalThis.Response} */
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
  const request = await requestFromSchema(
    /** @satisfies {Extract<Request, { kind: "list_files" }>} */ ({ kind: "list_files" }),
  );
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
  if (args.length === 0) exitWithError("Usage: agentctl fetch <path> [path ...]");
  const requestedPaths = uniquePaths(args);
  const request = await requestFromSchema(
    /** @satisfies {Extract<Request, { kind: "fetch" }>} */ ({
      kind: "fetch",
      paths: requestedPaths,
    }),
  );
  const response = await send(request);
  if (response.kind !== "files" || !Array.isArray(response.files)) {
    exitWithError("Fetch returned an invalid file response", response);
  }
  const state = await readState();
  const returnedPaths = new Set();
  for (const file of response.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string") {
      exitWithError("Fetch returned an invalid file response", file);
    }
    const filePath = normalizeProtocolPath(file.path);
    if (
      returnedPaths.has(filePath) ||
      !requestedPaths.includes(filePath) ||
      !Number.isInteger(file.version) ||
      file.version < 0 ||
      typeof file.content !== "string"
    ) {
      exitWithError("Fetch returned an invalid file response", file);
    }
    returnedPaths.add(filePath);
    const destination = workspacePath(filePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
    state.versions[filePath] = file.version;
    state.edited = state.edited.filter((editedPath) => editedPath !== filePath);
  }
  if (returnedPaths.size !== requestedPaths.length) {
    exitWithError("Fetch response did not include every requested file", response);
  }
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
  /** @type {Extract<Request, { kind: "commit" }>["writes"]} */
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
  const request = await requestFromSchema(
    /** @satisfies {Extract<Request, { kind: "commit" }>} */ ({
      kind: "commit",
      writes,
      reads,
    }),
  );
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
  const tasks = /** @type {Extract<Request, { kind: "create_tasks" }>["tasks"]} */ (parsed);
  const request = await requestFromSchema(
    /** @satisfies {Extract<Request, { kind: "create_tasks" }>} */ ({
      kind: "create_tasks",
      tasks,
    }),
  );
  return send(request);
}

/** @param {string[]} args */
async function done(args) {
  if (args.length !== 0) exitWithError("Usage: agentctl done");
  const request = await requestFromSchema(
    /** @satisfies {Extract<Request, { kind: "done" }>} */ ({ kind: "done" }),
  );
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
    "  fetch <path> [path ...]",
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
