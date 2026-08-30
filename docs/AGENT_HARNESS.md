# Agent Coordination Harness

The harness gives a Codex Agent a small command-line client for the
coordination protocol. User messages still enter through the existing
Playground. Shared-file operations go through the coordination server instead
of bypassing it through the Agent workspace.

```text
user -> Playground -> Agent Runtime -> agentctl -> router -> task/file server
```

## Runtime context

A coordinated `RunnerRequest` supplies the Launchpad server URL, project and
task identifiers, and an optional authentication token. The runners expose
that context to `agentctl` through environment variables. Secret values are
not placed in container command arguments.

Before every coordinated turn, the runner installs the client at
`.coordination/agentctl.mjs`, generates `.coordination/request-schema.json`
from the router's Zod request schema, and adds the workflow rules to the Agent
prompt. Every outgoing request is built through that installed runtime schema
and is also type-checked against the schema-inferred `Request` type.

## Agent workflow

```text
node .coordination/agentctl.mjs list-files
node .coordination/agentctl.mjs list-agents
node .coordination/agentctl.mjs fetch shared/order-api.contract.md
node .coordination/agentctl.mjs mark-edited repoA/src/App.tsx
node .coordination/agentctl.mjs commit
node .coordination/agentctl.mjs create-tasks tasks.json
node .coordination/agentctl.mjs done
```

`list-files` returns available server-side paths and versions without exposing
file contents or recording a read. The Agent uses it whenever it needs to find
a shared file and then uses `fetch` for every file it reads or edits.

`list-agents` returns the IDs of currently registered Agents and includes each
Agent's responsibility description when one has been provided. The Agent can
use those profiles to choose owners when creating subtasks.

After creating, editing, or deleting a file, the Agent calls `mark-edited`.
`commit` accepts no path arguments: it submits every tracked edited path and
includes the versions of fetched, read-only files as read evidence. This keeps
a fetched dependency out of the write set unless the Agent actually changed
it. A successful commit clears the local tracking state.

If a commit returns `STALE`, the Agent lists and fetches the moved files,
reapplies its changes, marks the edited paths, and retries. The Agent always
calls `done` when its task finishes, including when it had no files to commit.
The local and container runners check the successful `done` marker before they
accept a coordinated task run as complete.

When the task context includes available Agent profiles, the Agent may create
subtasks for better-suited Agents. It writes a JSON array whose objects contain
`id`, `detail`, `owner`, `depends_on`, and `writes`, using an available Agent id
as `owner`. The Agent saves that array to the workspace path represented by
`<json-file>` and passes that same path to `create-tasks <json-file>`.

The server store starts with a small fake repository for the demo. Future UI
uploads should populate that same store. Files should not be copied directly
into an Agent workspace because doing so would bypass fetch-time read tracking.

## Integration boundary

The router implements `CoordinationMessageHandler` and connects the protocol
requests to the task and file stores. Router connection and Agent-profile
discovery are owned by the router integration; the harness only supplies the
Agent-facing commands, typed request bodies, local tracking, and instructions.
