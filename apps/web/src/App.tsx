import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, SystemEvent, SystemInfo, Task } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  // Navigation View Tab: "orchestrator" | "playground"
  const [activeTab, setActiveTab] = useState<"orchestrator" | "playground">("orchestrator");

  // Platform State
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");

  // Middleware Orchestrator State
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);

  // Audit Stream Filters & Sorting
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterTask, setFilterTask] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const lastSeqRef = useRef<number>(0);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // Extract unique dynamic values for filtering
  const uniqueAgents = useMemo(() => {
    const set = new Set<string>();
    events.forEach((ev) => {
      if (ev.agent) set.add(ev.agent);
    });
    return Array.from(set);
  }, [events]);

  const uniqueTasks = useMemo(() => {
    const set = new Set<string>();
    events.forEach((ev) => {
      if (ev.task_id) set.add(ev.task_id);
    });
    return Array.from(set);
  }, [events]);

  // Compute filtered & sorted events
  const filteredEvents = useMemo(() => {
    let result = events.filter((ev) => {
      const matchAgent = filterAgent === "all" || ev.agent === filterAgent;
      const matchTask = filterTask === "all" || ev.task_id === filterTask;
      return matchAgent && matchTask;
    });

    if (sortOrder === "desc") {
      result = result.slice().reverse();
    } else {
      result = result.slice();
    }
    return result;
  }, [events, filterAgent, filterTask, sortOrder]);

  const refreshAgents = useCallback(async () => {
    try {
      const { agents: next } = await api.listAgents();
      setAgents(next);
      setSelectedId((current) =>
        current && next.some((agent) => agent.id === current)
          ? current
          : (next[0]?.id ?? null),
      );
    } catch {
      // Ignored during initial bootstrap polling
    }
  }, []);

  const refreshOrchestrator = useCallback(async () => {
    try {
      // 1. Fetch Task Matrix
      const tasksRes = await api.tasks().catch(() => ({ tasks: [] }));
      if (tasksRes.tasks && tasksRes.tasks.length > 0) {
        setTasks(tasksRes.tasks);
      } else {
        // Fallback mock tasks for UI demonstration
        setTasks((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  id: "task-001",
                  state: "done",
                  owner: "agent-parser",
                  depends_on: [],
                  writes: ["src/parser.py"],
                  strikes: 0,
                },
                {
                  id: "task-002",
                  state: "assigned",
                  owner: "agent-builder",
                  depends_on: ["task-001"],
                  writes: ["src/engine.ts", "package.json"],
                  strikes: 1,
                },
                {
                  id: "task-003",
                  state: "escalated",
                  owner: "agent-tester",
                  depends_on: ["task-002"],
                  writes: ["tests/suite.test.ts"],
                  strikes: 3,
                },
                {
                  id: "task-004",
                  state: "blocked",
                  owner: "agent-deployer",
                  depends_on: ["task-003"],
                  writes: ["deploy/manifest.yaml"],
                  strikes: 0,
                },
              ],
        );
      }

      // 2. Fetch incremental events via ?after=seq
      const eventsRes = await api.events(lastSeqRef.current).catch(() => ({ events: [] }));
      if (eventsRes.events && eventsRes.events.length > 0) {
        const nextEvents = eventsRes.events;
        lastSeqRef.current = nextEvents[nextEvents.length - 1].seq;
        setEvents((current) => [...current, ...nextEvents].slice(-100));
      } else {
        // Fallback mock events for initial preview
        setEvents((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  seq: 1,
                  at: new Date().toISOString(),
                  type: "request",
                  msg_id: "m-1",
                  agent: "agent-parser",
                  task_id: "task-001",
                  payload: {
                    body: {
                      kind: "fetch",
                      paths: ["src/parser.py"],
                    },
                  },
                },
                {
                  seq: 2,
                  at: new Date().toISOString(),
                  type: "response",
                  msg_id: "m-2",
                  agent: "agent-parser",
                  task_id: "task-001",
                  payload: {
                    ok: true,
                    kind: "commit_ok",
                  },
                },
                {
                  seq: 3,
                  at: new Date().toISOString(),
                  type: "response",
                  msg_id: "m-3",
                  agent: "agent-builder",
                  task_id: "task-002",
                  payload: {
                    ok: false,
                    code: "OCC_CONFLICT",
                    kind: "commit_rejected",
                  },
                },
                {
                  seq: 4,
                  at: new Date().toISOString(),
                  type: "error",
                  msg_id: "m-4",
                  agent: "agent-tester",
                  task_id: "task-003",
                  error: "Max retries (3 strikes) exceeded. Task escalated.",
                },
              ],
        );
      }
    } catch {
      // Graceful error capture
    }
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshOrchestrator(),
      api.system().then(setSystem),
    ]);
  }, [refreshAgents, refreshOrchestrator]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));

    const timer = setInterval(() => {
      if (mountedRef.current) void refreshOrchestrator();
    }, 1000);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [bootstrap, refreshOrchestrator]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">C</div>
          <span className="eyebrow">ClockedIt Platform</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">C</div>
          <span className="eyebrow">ClockedIt Platform</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Platform"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <strong>ClockedIt</strong>
            <span>Multi-Agent Coordination Platform</span>
          </div>
        </div>

        {/* View Switcher */}
        <div className="view-switcher">
          <button
            className={`tab-button ${activeTab === "orchestrator" ? "active" : ""}`}
            onClick={() => setActiveTab("orchestrator")}
          >
            Orchestrator
          </button>
          <button
            className={`tab-button ${activeTab === "playground" ? "active" : ""}`}
            onClick={() => setActiveTab("playground")}
          >
            Playground
          </button>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Active Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                if (activeTab !== "playground") setActiveTab("playground");
              }}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Worker Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              No active worker agents found.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">OCC Runtime Engine</span>
          <strong>{system?.runtime ?? "Ready"}</strong>
          <span>
            {system?.arkModel ?? "Ark Endpoint Active"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {activeTab === "orchestrator" ? (
          /* ==================== MULTI-AGENT ORCHESTRATOR & OCC VIEW ==================== */
          <div className="orchestrator-layout">
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>Multi-Agent Coordination</h1>
                  <span className="status status-ready">
                    <span className="status-dot" /> Live Coordinator
                  </span>
                </div>
              </div>
              <div className="header-actions">
                <button className="button button-ghost" onClick={() => refreshOrchestrator()}>
                  ↻ Refresh
                </button>
              </div>
            </header>

            {/* Metrics Ribbon */}
            <div className="occ-stats-ribbon">
              <div className="occ-stat-card">
                <span className="eyebrow">Total Pipeline Tasks</span>
                <strong>{tasks.length}</strong>
              </div>
              <div className="occ-stat-card">
                <span className="eyebrow">Assigned / Running</span>
                <strong className="text-blue">{tasks.filter((t) => t.state === "assigned").length}</strong>
              </div>
              <div className="occ-stat-card">
                <span className="eyebrow">Escalated (Intervention)</span>
                <strong className="text-red">{tasks.filter((t) => t.state === "escalated").length}</strong>
              </div>
              <div className="occ-stat-card">
                <span className="eyebrow">Completed</span>
                <strong className="text-green">{tasks.filter((t) => t.state === "done").length}</strong>
              </div>
            </div>

            <div className="dashboard-grid">
              {/* Task Matrix Table */}
              <section className="dashboard-section task-matrix-panel">
                <div className="section-header">
                  <div>
                    <span className="eyebrow">Task Execution Dashboard</span>
                  </div>
                </div>

                <div className="table-wrapper">
                  <table className="task-table">
                    <thead>
                      <tr>
                        <th>Task ID</th>
                        <th>State</th>
                        <th>Worker Agent</th>
                        <th>Dependencies</th>
                        <th>Intent (Target Writes)</th>
                        <th>Strikes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="empty-row">
                            No tasks currently in the queue.
                          </td>
                        </tr>
                      ) : (
                        tasks.map((task) => (
                          <tr
                            key={task.id}
                            className={task.state === "escalated" ? "row-escalated" : ""}
                          >
                            <td className="font-mono font-bold">{task.id}</td>
                            <td>
                              <span className={`task-badge badge-${task.state}`}>
                                {task.state}
                              </span>
                            </td>
                            <td className="font-mono">{task.owner}</td>
                            <td>
                              {task.depends_on.length > 0 ? (
                                <div className="tag-group">
                                  {task.depends_on.map((dep) => (
                                    <span key={dep} className="code-tag">
                                      {dep}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="muted-text">None</span>
                              )}
                            </td>
                            <td>
                              {task.writes.length > 0 ? (
                                <div className="tag-group">
                                  {task.writes.map((file) => (
                                    <span key={file} className="code-tag-amber">
                                      {file}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="muted-text">No target writes</span>
                              )}
                            </td>
                            <td>
                              <span
                                className={`strikes-badge ${
                                  task.strikes > 0 ? "has-strikes" : ""
                                }`}
                              >
                                {task.strikes}/3
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Real-Time OCC Event Stream with Filtering & Sorting */}
              <section className="dashboard-section events-stream-panel">
                <div className="section-header">
                  <div>
                    <span className="eyebrow">Audit Stream</span>
                  </div>
                  <span className="pulse" />
                </div>

                {/* Filter / Sort Control Bar */}
                <div className="stream-filter-bar">
                  <select
                    className="stream-select"
                    value={filterAgent}
                    onChange={(e) => setFilterAgent(e.target.value)}
                  >
                    <option value="all">All Agents</option>
                    {uniqueAgents.map((agent) => (
                      <option key={agent} value={agent}>
                        Agent: {agent}
                      </option>
                    ))}
                  </select>

                  <select
                    className="stream-select"
                    value={filterTask}
                    onChange={(e) => setFilterTask(e.target.value)}
                  >
                    <option value="all">All Tasks</option>
                    {uniqueTasks.map((taskId) => (
                      <option key={taskId} value={taskId}>
                        Task: {taskId}
                      </option>
                    ))}
                  </select>

                  <select
                    className="stream-select"
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value as "desc" | "asc")}
                  >
                    <option value="desc">Newest First</option>
                    <option value="asc">Oldest First</option>
                  </select>
                </div>

                <div className="events-stream">
                  {filteredEvents.length === 0 ? (
                    <div className="empty-events">No events match current filter.</div>
                  ) : (
                    filteredEvents.map((ev) => {
                      const detailSummary =
                        ev.error ??
                        ev.payload?.body?.kind ??
                        ev.payload?.kind ??
                        (ev.payload?.ok ? "Operation Succeeded" : "Event Dispatched");

                      return (
                        <div key={ev.seq} className={`event-item event-${ev.type}`}>
                          <div className="event-meta">
                            <span>
                              #{ev.seq} · {ev.agent}
                            </span>
                            <span className="event-task-tag">{ev.task_id || "no-task"}</span>
                          </div>
                          <strong className="event-type">{ev.type}</strong>
                          <p className="event-detail">
                            {detailSummary}
                            {ev.payload?.body?.paths && ` (${ev.payload.body.paths.join(", ")})`}
                            {ev.payload?.code && ` [${ev.payload.code}]`}
                          </p>
                          <span
                            className="event-time"
                            style={{ fontSize: "9px", color: "var(--muted)" }}
                          >
                            {formatTime(ev.at)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : (
          /* ==================== PLAYGROUND / WORKSPACE VIEW ==================== */
          selected ? (
            <>
              <header className="agent-header">
                <div>
                  <div className="header-title-row">
                    <h1>{selected.name}</h1>
                    <StatusPill status={selected.status} />
                  </div>
                  <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
                </div>
                <div className="header-actions">
                  <button
                    className="button button-ghost"
                    onClick={() => setShowSettings((value) => !value)}
                    disabled={busy || selected.status === "busy"}
                  >
                    Settings
                  </button>
                  <button
                    className="button button-ghost"
                    onClick={toggleAgent}
                    disabled={busy}
                  >
                    {selected.status === "stopped" ? "Start" : "Stop"}
                  </button>
                  <button
                    className="button button-danger"
                    onClick={deleteAgent}
                    disabled={busy || selected.status === "busy"}
                  >
                    Delete
                  </button>
                </div>
              </header>

              {showSettings && (
                <form className="settings-panel" onSubmit={saveAgent}>
                  <div className="settings-title">
                    <div>
                      <span className="eyebrow">Agent configuration</span>
                      <h2>Instructions and identity</h2>
                    </div>
                    <button type="button" onClick={() => setShowSettings(false)}>×</button>
                  </div>
                  <div className="form-grid">
                    <label>
                      Name
                      <input
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                        required
                        maxLength={80}
                      />
                    </label>
                    <label>
                      Description
                      <input
                        value={form.description}
                        onChange={(event) =>
                          setForm({ ...form, description: event.target.value })
                        }
                        maxLength={500}
                      />
                    </label>
                  </div>
                  <label>
                    System instructions
                    <textarea
                      value={form.instructions}
                      onChange={(event) =>
                        setForm({ ...form, instructions: event.target.value })
                      }
                      rows={5}
                      maxLength={10_000}
                    />
                  </label>
                  <div className="panel-footer">
                    <code>{selected.workspacePath}</code>
                    <button className="button button-primary" disabled={busy}>
                      {busy ? <Spinner /> : "Save changes"}
                    </button>
                  </div>
                </form>
              )}

              <section className="playground">
                <div className="playground-topbar">
                  <div>
                    <span className="eyebrow">Playground</span>
                    <h2>Direct Agent Workspace</h2>
                  </div>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>

                <div className="messages">
                  {messages.length === 0 && !activeRun ? (
                    <div className="welcome">
                      <div className="welcome-orbit">
                        <div>⌁</div>
                      </div>
                      <h3>What should {selected.name} build?</h3>
                      <p>
                        The Agent can inspect files, write code, run commands, and continue the
                        same Codex session across messages.
                      </p>
                      <div className="prompt-grid">
                        {starterPrompts.map((item) => (
                          <button key={item} onClick={() => setPrompt(item)}>
                            <span>↗</span>
                            {item}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.role === "user" ? "You" : selected.name}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                      </article>
                    ))
                  )}
                  {activeRun && ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is executing tasks and reconciling files…
                      </div>
                    </article>
                  )}
                  {activeRun?.status === "failed" && (
                    <article className="run-error">
                      <strong>Run failed</strong>
                      <span>{activeRun.error}</span>
                    </article>
                  )}
                  <div ref={messageEnd} />
                </div>

                <form className="composer" onSubmit={sendMessage}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={
                      selected.status === "stopped"
                        ? "Start this Agent to continue…"
                        : "Describe what you want the Agent to do…"
                    }
                    disabled={
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    rows={3}
                  />
                  <div className="composer-footer">
                    <span>
                      Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "sandbox active"}
                    </span>
                    <button
                      className="send-button"
                      disabled={
                        !prompt.trim() ||
                        selected.status === "stopped" ||
                        selected.status === "busy" ||
                        (activeRun != null && ["queued", "running"].includes(activeRun.status))
                      }
                      aria-label="Send message"
                    >
                      ↑
                    </button>
                  </div>
                </form>
              </section>
            </>
          ) : (
            <div className="no-agent">
              <div className="no-agent-art">C</div>
              <span className="eyebrow">Agent Launchpad</span>
              <h1>No Agent Selected.</h1>
              <p>Select an Agent from the sidebar or return to the Task Orchestrator.</p>
              <button
                className="button button-primary"
                onClick={() => {
                  setForm(emptyForm);
                  setShowCreate(true);
                }}
              >
                Create your first Agent
              </button>
            </div>
          )
        )}
      </main>

      {/* Modal for creating Agent */}
      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">NEW WORKSPACE</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button 
                type="button" 
                className="modal-close-btn" 
                onClick={() => setShowCreate(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="modal-form-body">
              <div className="form-group">
                <label htmlFor="agent-name">Name</label>
                <input
                  id="agent-name"
                  autoFocus
                  placeholder="Frontend Builder"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  required
                  maxLength={80}
                />
              </div>

              <div className="form-group">
                <label htmlFor="agent-desc">Description</label>
                <input
                  id="agent-desc"
                  placeholder="Builds polished React prototypes"
                  value={form.description}
                  onChange={(event) =>
                    setForm({ ...form, description: event.target.value })
                  }
                  maxLength={500}
                />
              </div>

              <div className="form-group">
                <label htmlFor="agent-inst">Instructions</label>
                <textarea
                  id="agent-inst"
                  value={form.instructions}
                  onChange={(event) =>
                    setForm({ ...form, instructions: event.target.value })
                  }
                  rows={5}
                  maxLength={10_000}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}