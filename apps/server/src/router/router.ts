import {
  commitResponseSchema,
  doneResponseSchema,
  agentProfilesResponseSchema,
  envelopeSchema,
  fileRefsResponseSchema,
  filesResponseSchema,
  notFoundResponseSchema,
  responseSchema,
  tasksResponseSchema,
} from "./schemas/router.schemas.js";
import type { CommitRequest, CreateTasksRequest, DoneRequest, Envelope, FetchRequest, ListFilesRequest, Response, RouterEvent } from "./router.types.js";
import type { AgentProfile } from "../types.js";
import type { Task } from "../task-server/task.types.js";

type RouterEventInput =
  | Omit<Extract<RouterEvent, { type: "request" }>, "seq" | "at">
  | Omit<Extract<RouterEvent, { type: "response" }>, "seq" | "at">
  | Omit<Extract<RouterEvent, { type: "error" }>, "seq" | "at">;

export interface AgentChannel {
  send(response: Response): void | Promise<void>;
}

export interface RouterCoordinator {
  listTasks?(): Promise<Task[]>;
  listFiles?(agentId: string, request: ListFilesRequest): Promise<Array<{ path: string; version: number }>>;
  onFetch(agentId: string, request: FetchRequest): Promise<Array<{ path: string; version: number; content: string }>>;
  onCommit(agentId: string, taskId: string, request: CommitRequest): Promise<Response>;
  onDone(agentId: string, taskId: string, request: DoneRequest): Promise<void>;
  onCreateTasks?(agentId: string, request: CreateTasksRequest): Promise<Array<{ id: string }>>;
}

/**
 * Placeholder until the server's task-server Coordinator is integrated.
 * Replace this with Coordinator.onFetch/onCommit/onDone/onCreateTasks.
 */
export const placeholderCoordinator: RouterCoordinator = {
  listFiles: async () => {
    throw new Error("Task-server Coordinator is not configured");
  },
  onFetch: async () => {
    throw new Error("Task-server Coordinator is not configured");
  },
  onCommit: async () => {
    throw new Error("Task-server Coordinator is not configured");
  },
  onDone: async () => {
    throw new Error("Task-server Coordinator is not configured");
  },
  onCreateTasks: async () => {
    throw new Error("Task-server Coordinator is not configured");
  },
};

/** Build a router around server-owned coordination callbacks. */
export function createRouter(coordinator: RouterCoordinator): Router {
  return new Router(coordinator);
}

/** Private protocol boundary. Agent channels are registered during startup. */
export class Router {
  private readonly agents = new Map<string, { channel: AgentChannel; description?: AgentProfile["description"] }>();
  private readonly events: RouterEvent[] = [];
  private eventSequence = 0;

  constructor(private readonly coordinator: RouterCoordinator) {}

  getEvents(after = 0): RouterEvent[] {
    return structuredClone(this.events.filter((event) => event.seq > after));
  }

  async getTasks(): Promise<Task[]> {
    if (!this.coordinator.listTasks) throw new Error("Task listing is not configured");
    return structuredClone(await this.coordinator.listTasks());
  }

  registerAgent(agentId: string, channel: AgentChannel, profile: Partial<Pick<AgentProfile, "description">> = {}): () => void {
    if (!agentId.trim()) throw new Error("agentId is required");
    this.agents.set(agentId, {
      channel,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
    });
    return () => { if (this.agents.get(agentId)?.channel === channel) this.agents.delete(agentId); };
  }

  updateAgentProfile(agentId: string, profile: Pick<AgentProfile, "description">): void {
    const registration = this.agents.get(agentId);
    if (registration) registration.description = profile.description;
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  hasAgent(agentId: string): boolean { return this.agents.has(agentId); }

  async dispatch(agentId: string, response: Response): Promise<void> {
    const registration = this.agents.get(agentId);
    if (!registration) throw new Error(`Agent is not registered: ${agentId}`);
    const parsed = responseSchema.parse(response);
    this.emit({
      type: "response",
      msg_id: null,
      agent: agentId,
      task_id: null,
      payload: parsed,
    });
    await registration.channel.send(parsed);
  }

  async handleMessage(input: unknown): Promise<Response | null> {
    const envelope = envelopeSchema.parse(input);
    if (!this.agents.has(envelope.agent)) throw new Error(`Agent is not registered: ${envelope.agent}`);
    this.emit({
      type: "request",
      msg_id: envelope.msg_id,
      agent: envelope.agent,
      task_id: envelope.task_id,
      payload: envelope,
    });
    try {
      const response = await this.route(envelope);
      if (response === null) return null;
      const parsed = responseSchema.parse(response);
      this.emit({
        type: "response",
        msg_id: envelope.msg_id,
        agent: envelope.agent,
        task_id: envelope.task_id,
        payload: parsed,
      });
      return parsed;
    } catch (error) {
      this.emit({
        type: "error",
        msg_id: envelope.msg_id,
        agent: envelope.agent,
        task_id: envelope.task_id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private emit(event: RouterEventInput): void {
    const complete = { ...event, seq: ++this.eventSequence, at: new Date().toISOString() } as RouterEvent;
    this.events.push(complete);
    if (this.events.length > 500) this.events.shift();
  }

  private async route(envelope: Envelope): Promise<Response | null> {
    const { agent, task_id: taskId, body } = envelope;
    switch (body.kind) {
      case "list_files":
        if (!this.coordinator.listFiles) throw new Error("list_files is not configured");
        return fileRefsResponseSchema.parse({
          ok: true,
          kind: "file_refs",
          files: await this.coordinator.listFiles(agent, body),
        });
      case "list_agents":
        return agentProfilesResponseSchema.parse({
          ok: true,
          kind: "agent_profiles",
          agents: [...this.agents.entries()].map(([agentId, registration]): AgentProfile => ({
            id: agentId,
            description: registration.description ?? "",
          })),
        });
      case "fetch": {
        const files = await this.coordinator.onFetch(agent, body);
        const returnedPaths = new Set(files.map((file) => file.path));
        const missingPaths = body.paths.filter((path) => !returnedPaths.has(path));
        if (missingPaths.length > 0) {
          return notFoundResponseSchema.parse({ ok: false, code: "NOT_FOUND", paths: missingPaths });
        }
        return filesResponseSchema.parse({ ok: true, kind: "files", files });
      }
      case "commit":
        if (!taskId) throw new Error("commit requires a task_id");
        return commitResponseSchema.parse(
          await this.coordinator.onCommit(agent, taskId, body),
        );
      case "done":
        if (!taskId) throw new Error("done requires a task_id");
        await this.coordinator.onDone(agent, taskId, body);
        return doneResponseSchema.parse({ ok: true, kind: "done" });
      case "create_tasks":
        if (!this.coordinator.onCreateTasks) throw new Error("create_tasks is not configured");
        return tasksResponseSchema.parse({
          ok: true,
          kind: "tasks",
          task_ids: (await this.coordinator.onCreateTasks(agent, body)).map((task) => task.id),
        });
    }
  }
}
