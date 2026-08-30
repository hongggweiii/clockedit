# Coordination Message Protocol

This document describes the minimal push-model contract between an Agent
Runtime and the coordination router. The executable source of truth is in the
strict Zod schemas under `apps/server/src/router/schemas`.

## Envelope

Every Agent request uses the same envelope:

```json
{
  "msg_id": "5ad35cb4-3863-4c69-94b8-c829fbaa78d3",
  "agent": "frontend",
  "task_id": "frontend-cancel-button",
  "body": {
    "kind": "done"
  }
}
```

- `msg_id` is a UUID used as the request identifier.
- `agent` identifies the sender.
- `task_id` is required for `done` and may accompany other messages when task
  context is available.
- Unknown fields are rejected.

Agents do not claim tasks. The task server pushes assigned work to them and the
happy path assumes they accept it. Agents also do not announce a separate
write intent; a `commit` reports the modifications.

## Requests

| Kind | Purpose |
| --- | --- |
| `list_files` | Discover current shared paths and versions without reading contents. |
| `fetch` | Fetch selected shared content and record the read. |
| `commit` | Submit writes and the versions of read dependencies. |
| `create_tasks` | Submit owner-aware subtasks from a JSON task list. |
| `done` | Report completion of the assigned task. |

### Discover files

```json
{
  "kind": "list_files"
}
```

```json
{
  "ok": true,
  "kind": "files",
  "files": [
    { "path": "repoA/src/App.tsx", "version": 1 },
    { "path": "shared/order-api.contract.md", "version": 3 }
  ]
}
```

Listing exposes only paths and versions. The Agent must still fetch a file so
the server can record that the task read it.

### Fetch files

The shared request schema accepts one or more unique paths. `agentctl fetch`
sends one path at a time so each returned file can be validated and written to
the matching workspace path.

```json
{
  "kind": "fetch",
  "paths": ["shared/order-api.contract.md"]
}
```

```json
{
  "ok": true,
  "kind": "file",
  "path": "shared/order-api.contract.md",
  "version": 3,
  "content": "# Order API contract"
}
```

### Commit tracked edits

```json
{
  "kind": "commit",
  "writes": [
    {
      "path": "repoA/src/App.tsx",
      "content": "export function App() {}",
      "based_on": 7
    }
  ],
  "reads": [
    {
      "path": "shared/order-api.contract.md",
      "version": 3
    }
  ]
}
```

`based_on: null` means the Agent expects to create a new file. If a write base
or read dependency moved, the server rejects the entire commit:

```json
{
  "ok": false,
  "code": "STALE",
  "moved": [
    {
      "path": "shared/order-api.contract.md",
      "had": 3,
      "now": 4
    }
  ]
}
```

The Agent then refetches the moved files, reapplies its work, and retries.

### Create owner-aware tasks

```json
{
  "kind": "create_tasks",
  "tasks": [
    {
      "id": "backend-contract",
      "detail": "Update the order API contract",
      "owner": "backend",
      "depends_on": [],
      "writes": ["shared/order-api.contract.md"]
    }
  ]
}
```

Agent-profile discovery and dispatch belong to the router integration. The
harness instructs the Agent to select an available Agent id as `owner`, write
the tasks to a JSON file, and submit that file with `create-tasks`.

## Ownership boundary

- The shared schemas own request and response validation.
- The harness owns Agent commands, local read/edit tracking, and workflow
  instructions.
- The router owns Agent discovery, task dispatch, and transport integration.
- The file store owns version allocation, read tracking, and atomic commits.
