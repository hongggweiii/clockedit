# Coordination Message Protocol

This document defines the JSON contract between an Agent Runtime and the
coordination server. It deliberately does not define HTTP routes, persistence,
the task-queue algorithm, or UI behavior. Those components share this contract
but own their own implementation.

The executable source of truth is
[`apps/server/src/coordination-schema.ts`](../apps/server/src/coordination-schema.ts).
It exports strict Zod schemas, inferred TypeScript types, and parse helpers.
The current contract revision is `COORDINATION_SCHEMA_VERSION = 1`.

## Rules shared by every flow

- The coordination server is the only writer of shared state.
- Each Agent request has a UUID `msg_id`. A retried container must reuse the
  same ID, and the server must return the original result instead of applying
  the request twice.
- `agent` identifies the sender. `task_id` identifies the task affected by the
  request and is required for `claim`, `intent`, `commit`, and `done`.
- Versions are non-negative integers. A `FileWrite.based_on` value of `null`
  means that the Agent expects the file to be new.
- Schemas reject unknown fields. This catches mismatched field names at the
  boundary rather than silently dropping data.
- `next` is a concise instruction that an Agent or `agentctl` can display after
  a response. It is not a second command or a state-machine transition.

## Agent request envelope

Every Agent-to-server request has the same outer shape:

```json
{
  "msg_id": "5ad35cb4-3863-4c69-94b8-c829fbaa78d3",
  "agent": "backend",
  "task_id": "cancel-order-api",
  "body": {
    "kind": "claim"
  }
}
```

`body.kind` selects one request:

| Kind | Purpose | `task_id` required |
| --- | --- | --- |
| `claim` | Atomically claim one unblocked task. First claimant wins. | Yes |
| `intent` | Announce files before editing so overlaps are caught before work. | Yes |
| `fetch` | Fetch the last saved version of a file and record the read. | No |
| `commit` | Submit writes plus every read/version the work depended on. | Yes |
| `heartbeat` | Refresh Agent liveness. This is last-write-wins status data. | No |
| `inbox` | Read tasks and events waiting for an Agent that may have been offline. | No |
| `done` | Report that the current task is complete. Repeats must be idempotent. | Yes |

### Declare intent

```json
{
  "msg_id": "1a071893-b00e-42f0-9198-ab79ae7e4253",
  "agent": "backend",
  "task_id": "cancel-order-api",
  "body": {
    "kind": "intent",
    "writes": ["src/api/orders.ts", "contracts/order-api.json"]
  }
}
```

If another active task declared an overlapping path, the server returns
`INTENT_CONFLICT`, freezes the affected paths, and creates an escalation for a
human. Retrying is not appropriate because an overlap represents a real
disagreement rather than bad timing.

### Fetch a shared file

```json
{
  "msg_id": "99c00b9d-6c9a-4dfb-8b97-64e79516dafb",
  "agent": "frontend",
  "task_id": "frontend-cancel-button",
  "body": {
    "kind": "fetch",
    "path": "contracts/order-api.json"
  }
}
```

Successful response:

```json
{
  "ok": true,
  "kind": "file",
  "path": "contracts/order-api.json",
  "version": 3,
  "content": "{\"response\":{\"order_id\":\"string\"}}",
  "next": "Use this version and include it in reads when committing."
}
```

### Commit writes and read evidence

```json
{
  "msg_id": "b6fc3a88-e456-4788-877b-b67267822f9c",
  "agent": "frontend",
  "task_id": "frontend-cancel-button",
  "body": {
    "kind": "commit",
    "writes": [
      {
        "path": "src/App.tsx",
        "content": "export function CancelButton() {}",
        "based_on": 7
      }
    ],
    "reads": [
      {
        "path": "contracts/order-api.json",
        "version": 3
      }
    ]
  }
}
```

If either a write base or a recorded read moved, no write is applied. The
response names every moved path:

```json
{
  "ok": false,
  "code": "STALE",
  "moved": [
    {
      "path": "contracts/order-api.json",
      "had": 3,
      "now": 4
    }
  ],
  "next": "Refetch the moved files and retry the task."
}
```

The Agent may retry after refetching. After three unsuccessful attempts, the
task reaches its strike limit and is escalated according to the task-state
algorithm.

## Responses and error codes

Successful responses use `ok: true` and one of `claimed`, `intent_accepted`,
`file`, `committed`, `heartbeat`, `inbox`, or `done`.

| Error code | Meaning | Expected action |
| --- | --- | --- |
| `NOT_OWNER` | The Agent does not own the task. | Stop and ask for another task. |
| `NOT_FOUND` | The requested file does not exist. | Correct the path or create it with `based_on: null`. |
| `STALE` | A written or read dependency changed. | Refetch and retry. |
| `TASK_BLOCKED` | A dependency is not done. | Wait for the dependency. |
| `TASK_TAKEN` | Another Agent won the claim. | Pick another task. |
| `INTENT_CONFLICT` | Active tasks announced overlapping files. | Freeze and request a human decision. |
| `FROZEN` | A human decision is still pending for these paths. | Stop writing to the paths. |
| `FORBIDDEN` | The Agent lacks access to the target repository. | Stop; do not retry unchanged. |
| `INVALID_STATE` | The request is not legal in the current task state. | Follow `detail` and `next`. |

## Events

Events are server-authored, numbered with a strictly increasing `seq`, and
append-only. They form the audit trail and the UI timeline.

```json
{
  "seq": 1,
  "type": "assigned",
  "agent": "backend",
  "task_id": "cancel-order-api",
  "detail": "Task assigned after its dependencies cleared."
}
```

Supported event types are `assigned`, `intent_declared`, `intent_conflict`,
`commit_ok`, `commit_rejected`, `done`, `heartbeat_expired`, `requeued`,
`escalated`, and `resolved`.

## Ownership boundary

- This protocol owns field names, allowed variants, validation, and examples.
- Routing owns how requests and responses travel between the server and Agent
  containers, including the `agentctl` commands.
- The server algorithm owns task ordering, state transitions, leases, retries,
  freezes, escalation, and idempotent handling.
- The file store owns version allocation, read tracking, and atomic commits.
- The UI consumes tasks and events but does not enforce coordination rules.
