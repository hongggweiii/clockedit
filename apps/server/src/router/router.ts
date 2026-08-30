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
import type { CommitRequest, CreateTasksRequest, DoneRequest, Envelope, FetchRequest, ListFilesRequest, Response } from "./router.types.js";
import type { AgentProfile } from "../types.js";

export interface AgentChannel {
  send(response: Response): void | Promise<void>;
}

export interface RouterCoordinator {
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

  constructor(private readonly coordinator: RouterCoordinator) {}

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
    await registration.channel.send(responseSchema.parse(response));
  }

  async handleMessage(input: unknown): Promise<Response | null> {
    const envelope = envelopeSchema.parse(input);
    if (!this.agents.has(envelope.agent)) throw new Error(`Agent is not registered: ${envelope.agent}`);
    const response = await this.route(envelope);
    return response === null ? null : responseSchema.parse(response);
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
