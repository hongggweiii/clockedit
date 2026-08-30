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
  role: string | null;
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

export type TaskState =
  | "pending"
  | "ready"
  | "dispatched"
  | "running"
  | "committing"
  | "completed"
  | "conflict"
  | "frozen"
  | "failed";

export type ProjectState = "active" | "completed" | "frozen";

export interface TaskIntent {
  reads: string[];
  writes: string[];
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  role: string;
  dependsOn: string[];
  intent: TaskIntent;
  state: TaskState;
  attempt: number;
  assignedAgentId: string | null;
  runId: string | null;
  readVersions: Record<string, string> | null;
  writtenPaths: string[] | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  state: ProjectState;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
<<<<<<< HEAD
  files: Record<string, StoredFile>;
  reads: Record<string, Record<string, number>>;
  events: StoredEvent[];
  eventSeq: number;
=======
  projects: Project[];
  tasks: Task[];
>>>>>>> afc78d9 (Implement server logic for multi-agent coordination)
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  role?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  role?: string | null | undefined;
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
  baseUrl: string;
  projectId: string;
  taskId: string | null;
  authToken?: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
