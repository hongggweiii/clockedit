import type { StoredEvent, StoredFile } from "./storage/file-store.types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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

/** Public identity and responsibility details exposed to coordinating Agents. */
export type AgentProfile = Pick<Agent, "id" | "description">;

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  files: Record<string, StoredFile>;
  reads: Record<string, Record<string, number>>;
  events: StoredEvent[];
  eventSeq: number;
  // Task-server persistence. Stored as `unknown[]` here to avoid a circular
  // type import with router schemas; the task-server casts through its own
  // InternalTask (see apps/server/src/task-server/task.types.ts).
  tasks: unknown[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  /** Optional deterministic id (used by demo scenario seeding). */
  id?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  coordination?: CoordinationContext;
}

export interface CoordinationContext {
  /** Host-process URL used for the AgentService SSE loopback. */
  baseUrl: string;
  /** Optional URL reachable from an isolated Runtime container. */
  runtimeBaseUrl?: string;
  projectId: string;
  taskId: string | null;
  authToken?: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
