# Demo scenario 1 — dependency waiting + versioning STALE rejection

**What it shows**
- Task dependencies: T2 waits for T1, T3 waits for T2
- Optimistic concurrency: while T2 is running, T4 rewrites a file T2 already
  read; T2's commit is rejected as `STALE`; T2 re-fetches and retries

**Expected timeline**

```
T1 backend   orders.ts v1 → v2                       commit_ok
T2 frontend  fetch orders.ts @ v2, starts writing
T4 backend   orders.ts v2 → v3 (renames field)       commit_ok
T2 frontend  commit repoA/src/App.tsx                commit_rejected
             STALE moved: repoB/src/api/orders.ts, had 2, now 3
T2 frontend  fetch @ v3, reapply, commit             commit_ok
T3 qa        reads both, agree                       PASS
```

---

## Architecture prerequisites (what's wired for you)

- **Public app** on `HOST:PORT` (default `127.0.0.1:3000`), bearer =
  `APP_AUTH_TOKEN`. Serves the UI, agent CRUD, `POST/GET /api/tasks`, and the
  router activity feed `GET /api/events?after=N`.
- **Private task-server** on `TASK_SERVER_HOST:TASK_SERVER_PORT` (default
  `127.0.0.1:4000`), bearer = `TASK_SERVER_AUTH_TOKEN`. Serves `POST /messages`
  (agent envelopes) and `GET /events?agent_id=X` (per-agent SSE channel).
- **AgentService opens the SSE loopback for you.** When you `POST /api/agents`,
  the server immediately opens a `GET /events?agent_id=…` SSE connection back
  to itself and registers a per-agent `AgentChannel`. If the SSE handshake
  fails, the create call returns **503** and the agent is rolled back.
- **LocalDispatchPushAdapter** wires task dispatch to Codex spawn: when the
  Coordinator assigns a task to an owner, it calls
  `AgentService.sendMessage(owner, prompt)` and Codex runs the agent through
  the Playground path, using `agentctl` for fetch / commit / done.

You don't need to manage the SSE handshake or trigger agents manually. Submit
tasks and let the coordinator drive it.

---

## 1. Boot the server

Both listeners are started by the poc script:

```bash
set -a && source .env && set +a
LOCAL_POC_DATA_ROOT="$PWD/.local/demo-scenario-1" npm run poc
```

This keeps the demo state separate from previous POC runs. After an incomplete
attempt, use a new suffix such as `demo-scenario-1-retry` so old assigned tasks
and agent ids do not affect the rerun.

Confirm both are up:

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:4000/health
```

## 2. Seed the three agents

The scenario's task JSON uses `owner: "backend" | "frontend" | "qa"`. Each
agent must be created with `id` pinned to that name.

```bash
BEARER="Authorization: Bearer $APP_AUTH_TOKEN"

curl -s -X POST http://127.0.0.1:3000/api/agents \
  -H "content-type: application/json" -H "$BEARER" \
  -d '{
    "id": "backend",
    "name": "backend",
    "description": "Owns the order API in repoB.",
    "instructions": "You own the order API in repoB. Only write files under repoB. Fetch a file before you read or edit it. Other agents are working at the same time and every file is versioned, so if a commit is rejected as STALE, fetch the paths named in the rejection, reapply your change, and commit again. Do not create tasks. Run done when finished."
  }'

curl -s -X POST http://127.0.0.1:3000/api/agents \
  -H "content-type: application/json" -H "$BEARER" \
  -d '{
    "id": "frontend",
    "name": "frontend",
    "description": "Owns the web UI in repoA.",
    "instructions": "You own the web UI in repoA. Only write files under repoA. The API lives in repoB, which you may read but never write. Never guess field names: fetch repoB/src/api/orders.ts and use exactly the names it returns. Other agents are working at the same time and every file is versioned, so if a commit is rejected as STALE, fetch the paths named in the rejection, reapply your change, and commit again. Do not create tasks. Run done when finished."
  }'

curl -s -X POST http://127.0.0.1:3000/api/agents \
  -H "content-type: application/json" -H "$BEARER" \
  -d '{
    "id": "qa",
    "name": "qa",
    "description": "Reviews both repos and assigns fixes.",
    "instructions": "You review both repos and never change application code. Only write files under qa. Fetch repoA/src/App.tsx and repoB/src/api/orders.ts, then write a report whose first line is PASS or FAIL followed by one short paragraph. If they disagree on field names, name the field and create one task to fix it, owned by the agent that owns the file that is wrong: backend owns repoB, frontend owns repoA. Save the task array as JSON in your workspace and submit it with create-tasks. Run done when finished."
  }'
```

Each `POST /api/agents` returns 201 with the agent record. If any returns 503
`Agent coordination is unavailable`, the loopback SSE couldn't connect — check
that the private task-server is running and reachable at
`TASK_SERVER_BASE_URL`.

Verify all three registered with the router:

```bash
curl -s -H "$BEARER" http://127.0.0.1:3000/api/agents | jq '.agents[] | {id, name, status}'
```

## 3. Open the router activity feed (optional narration)

For a live view in a second terminal, redraw only the latest 20 events:

```bash
while true; do clear; curl -s -H "$BEARER" http://127.0.0.1:3000/api/events | jq '.events[-20:][] | {seq, type, agent, task_id}'; sleep 1; done
```

Each request the agents make (`fetch`, `commit`, `done`, `list_agents`, etc.)
plus each dispatched response appears here. This is the audit trail.

To inspect a scrollable snapshot instead, run:

```bash
curl -s -H "$BEARER" http://127.0.0.1:3000/api/events | jq '.events[] | {seq, type, agent, task_id}' | less
```

Do not pipe `watch` into `less`; `watch` emits terminal redraw codes that show
up as `ESC` text. Press `Ctrl+C` to stop the live loop and `q` to exit `less`.

## 4. Submit the initial DAG (T1, T2, T3)

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "content-type: application/json" -H "$BEARER" \
  -d '{
    "tasks": [
      {
        "id": "T1",
        "owner": "backend",
        "depends_on": [],
        "writes": ["repoB/src/api/orders.ts"],
        "detail": "Add a cancelOrder(id) function that returns the same fields as getOrder."
      },
      {
        "id": "T2",
        "owner": "frontend",
        "depends_on": ["T1"],
        "writes": ["repoA/src/App.tsx"],
        "detail": "Add a Cancel button to the order dashboard that calls cancelOrder and shows the returned status. Follow this sequence exactly. First fetch both repoA/src/App.tsx and repoB/src/api/orders.ts exactly once. Then run sleep 90 exactly once; do not call list-files or fetch again during this wait. After the sleep, edit repoA/src/App.tsx using the initially fetched backend content, mark it edited, and commit once so the changed backend read produces STALE. After STALE, never sleep or poll again: immediately fetch every path listed in moved, reapply the required frontend change, mark repoA/src/App.tsx edited, retry commit, and run done."
      },
      {
        "id": "T3",
        "owner": "qa",
        "depends_on": ["T2"],
        "writes": ["qa/report.md"],
        "detail": "Check that repoA/src/App.tsx and repoB/src/api/orders.ts agree on field names. Write PASS or FAIL."
      }
    ]
  }'
```

Response: `201` with the persisted tasks. Immediately, the coordinator
dispatches T1 to `backend`, the push adapter calls `sendMessage`, and Codex
starts working. T2 stays `blocked` until T1 finishes.

## 5. Poll task state until T2 is `assigned`

```bash
watch -n 1 'curl -s -H "'"$BEARER"'" http://127.0.0.1:3000/api/tasks | jq ".tasks[] | {id, state, owner, strikes}"'
```

This output is intentionally short. Use `watch` alone here rather than piping
it into `less`.

You should see the transitions:

```
T1  assigned    → done
T2  blocked     → assigned (once T1 is done)
```

## 6. Once T2 has fetched the file, inject T4

First wait until the activity feed shows this response:

```text
agent=frontend  task_id=T2  payload.kind=files
```

T2 has now recorded both files' versions and is in its one-time 90-second
sleep. Sleeping does not generate model output or repeated coordination tool
turns. Backend has finished T1 and is idle. Send T4 (also written to
`repoB/src/api/orders.ts`, no deps):

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "content-type: application/json" -H "$BEARER" \
  -d '{
    "tasks": [
      {
        "id": "T4",
        "owner": "backend",
        "depends_on": [],
        "writes": ["repoB/src/api/orders.ts"],
        "detail": "Rename the field order_id to orderId in repoB/src/api/orders.ts. Do not touch repoA."
      }
    ]
  }'
```

Backend picks up T4 immediately. When it commits, `repoB/src/api/orders.ts`
goes from v2 to v3. When T2's one-time sleep finishes, it attempts its first
commit while its recorded backend read is still version 2.

## 7. Observe the STALE rejection + retry

Now Frontend (still working on T2) is holding a stale read for
`repoB/src/api/orders.ts` (v2). When it commits:

```
{
  "ok": false,
  "code": "STALE",
  "moved": [{"path": "repoB/src/api/orders.ts", "had": 2, "now": 3}]
}
```

Per the harness instructions, Frontend fetches the moved path (now v3),
reapplies its edits against the new field names, and commits again — this
time successfully. T2 → `done`.

You'll see `T2.strikes` tick to 1 during the rejection.

## 8. QA closes it out

T2 → `done` unblocks T3. QA fetches both files, writes `qa/report.md` starting
with `PASS`, commits, and marks done.

## 9. Verify the outcome

Task states — all four should be `done`:

```bash
curl -s -H "$BEARER" http://127.0.0.1:3000/api/tasks | jq '.tasks[] | {id, state, strikes}'
```

Commit event log — the third row is the versioning check the scenario
showcases:

| # | type              | agent    | task |
|---|-------------------|----------|------|
| 1 | commit_ok         | backend  | T1   |
| 2 | commit_ok         | backend  | T4   |
| 3 | commit_rejected   | frontend | T2   |
| 4 | commit_ok         | frontend | T2   |
| 5 | commit_ok         | qa       | T3   |

Pull just the commit events from the audit log:

```bash
curl -s -H "$BEARER" http://127.0.0.1:3000/api/events | jq '.events[] | select(.type=="response") | {seq, agent, task_id, kind: .payload.kind, code: .payload.code}'
```

Or fetch the FileStore's own commit log:

```bash
curl -s -H "$BEARER" http://127.0.0.1:3000/api/tasks | jq '.tasks | map({id, state, strikes})'
```

---

## Automated confirmation

The exact scenario is exercised without Codex or HTTP by:

```bash
npm run test -w @launchpad/server -- src/scenarios/scenario-1.test.ts
```

That test drives the Coordinator directly, submits T1–T3, walks each agent
through fetch/commit/done, injects T4 mid-run, asserts the STALE + retry, and
verifies the final file versions + audit log. If it passes, the coordination
logic supports the manual demo — the only variables the manual run adds are
Codex's LLM behavior (whether it actually writes the right code) and the SSE
transport.

---

## Troubleshooting

**`POST /api/agents` returns 503.** The task-server loopback SSE failed to
connect. Check `TASK_SERVER_BASE_URL`, `TASK_SERVER_AUTH_TOKEN`, and that both
listeners are up.

**Tasks stay `blocked` or `unassigned` forever.** Confirm `POST /api/tasks`
returned 201, then check `/api/agents` — all owner ids must exist. Owner
mismatches manifest as `DAG rejected` 400 responses on submit.

**Agent shows `busy` but nothing happens.** Codex is still running. Check
`GET /api/agents/:id/runs` for the active run and its output.

**An Agent run completes but its task remains `assigned`.** Inspect the run's
assistant output. If it says the coordination server was unreachable, restart
with `npm run poc`; the script configures a private-server URL reachable from
Docker or Podman. The strike counter only changes after a stale `commit`
actually reaches the Coordinator.

**A commit is unexpectedly rejected as STALE.** Someone (or something) wrote
to a path the agent read at an older version. Confirm the FileStore head via
the `list_files` request or read from the raw JSON store at
`.data/launchpad.json` → `files`.
