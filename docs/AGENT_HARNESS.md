# Agent Coordination Harness

The harness gives a Codex Agent a small command-line client for the coordination
protocol. User messages still enter through the existing Playground. Shared-file
operations go through the coordination server instead of bypassing it through
the Agent workspace.

```text
user -> Playground -> Agent Runtime -> agentctl -> router -> task/file server
```

## Contract decisions

- The router endpoint is
  `POST /api/projects/:projectId/coordination/messages`.
- `projectId` is the storage namespace. File paths inside a project are relative
  forward-slash paths such as `src/api/orders.ts`.
- File versions are non-negative integers.
- JSON on the wire uses snake_case, including `task_id`, `depends_on`, and
  `based_on`. Storage implementations may adapt those names internally.
- The endpoint accepts an `Envelope` and returns a validated `Response`.
- The endpoint returns HTTP 503 until a `CoordinationMessageHandler` is connected.

This endpoint belongs to the Launchpad application. It is not the Volcengine
Ark model endpoint.

## Runtime context

A coordinated `RunnerRequest` supplies:

- `baseUrl`: the Launchpad server URL reachable from the Runtime.
- `projectId`: the project whose files and tasks are in scope.
- `taskId`: the current task, or `null` for orchestrator-level operations.
- `authToken`: the optional Launchpad bearer token.

The runners expose this context as environment variables. Secret values are
passed through the process environment and are not placed in container command
arguments.

Before every turn, the runner installs the client at
`.coordination/agentctl.mjs`. Coordinated prompts tell the Agent when to use it.

## Agent commands

```text
node .coordination/agentctl.mjs claim
node .coordination/agentctl.mjs intent src/App.tsx
node .coordination/agentctl.mjs list-files
node .coordination/agentctl.mjs fetch contracts/order-api.json
node .coordination/agentctl.mjs commit src/App.tsx
node .coordination/agentctl.mjs heartbeat
node .coordination/agentctl.mjs inbox
node .coordination/agentctl.mjs done
node .coordination/agentctl.mjs create-tasks tasks.json
```

`list-files` returns the available server-side paths and versions without file
contents. `fetch` writes the selected last committed file into the Agent
workspace and records its version in `.coordination/state.json`. `commit` reads
the selected workspace files, supplies `based_on` for each write, and includes
every other fetched file as read evidence. A successful commit updates the
recorded versions.

The server store starts with a small set of fake repository files for the demo.
Future UI uploads should populate that same store. They should not be copied
directly into an Agent workspace because doing so would bypass fetch-time read
tracking.

Protocol failures are printed as JSON and exit non-zero. This lets the Agent
distinguish retryable `STALE` responses from `FROZEN`, ownership, permission,
and invalid-state failures.

## Integration boundary

The router implements `CoordinationMessageHandler`:

```ts
interface CoordinationMessageHandler {
  handleMessage(projectId: string, envelope: Envelope): Response | Promise<Response>;
}
```

The handler owns routing and delegates task behavior and storage behavior to
their respective components. The harness does not allocate versions, change
task state, or write shared storage directly.
