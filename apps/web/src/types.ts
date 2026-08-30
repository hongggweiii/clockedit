export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type EventType = "request" | "response" | "error";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export type TaskState = "blocked" | "assigned" | "escalated" | "done";

export interface Task {
  id: string;
  state: TaskState;
  owner: string; // agent running this task
  depends_on: string[];
  writes: string[];
  strikes: number; // 0..3, then escalated
}

export interface SystemEvent {
  seq: number;
  at: string;
  type: EventType;
  msg_id: string;
  agent: string;
  task_id: string | null;
  payload?: {
    ok?: boolean;
    kind?: string;
    body?: {
      kind?: string;
      paths?: string[];
      writes?: Array<{ path: string; content: string; based_on: number | null }>;
      reads?: Array<{ path: string; version: number }>;
    };
    files?: unknown[];
    versions?: Record<string, number>;
    code?: string;
    moved?: Array<{ path: string; had: number; now: number }>;
  };
  error?: string;
}