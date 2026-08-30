import { envelopeSchema, responseSchema } from "./schemas/router.schemas.js";
import type { CommitRequest, CreateTasksRequest, DoneRequest, Envelope, FetchRequest, ListFilesRequest, Response } from "./router.types.js";

export interface AgentChannel {
  send(response: Response): void | Promise<void>;
}

export interface RouterCoordinator {
  listFiles?(agentId: string, request: ListFilesRequest): Promise<Array<{ path: string; version: number }>>;
  fetch(agentId: string, request: FetchRequest): Promise<Array<{ path: string; version: number; content: string }>>;
  commit(agentId: string, taskId: string, request: CommitRequest): Promise<Response>;
  done(agentId: string, taskId: string, request: DoneRequest): Promise<void>;
  createTasks?(agentId: string, request: CreateTasksRequest): Promise<Array<{ id: string }>>;
}

/** Private protocol boundary. Agent channels are registered during startup. */
export class Router {
  private readonly agents = new Map<string, AgentChannel>();

  constructor(private readonly coordinator: RouterCoordinator) {}

  registerAgent(agentId: string, channel: AgentChannel): () => void {
    if (!agentId.trim()) throw new Error("agentId is required");
    this.agents.set(agentId, channel);
    return () => { if (this.agents.get(agentId) === channel) this.agents.delete(agentId); };
  }

  hasAgent(agentId: string): boolean { return this.agents.has(agentId); }

  async dispatch(agentId: string, response: Response): Promise<void> {
    const channel = this.agents.get(agentId);
    if (!channel) throw new Error(`Agent is not registered: ${agentId}`);
    await channel.send(responseSchema.parse(response));
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
        return { ok: true, kind: "files", files: await this.coordinator.listFiles(agent, body) };
      case "fetch": {
        const files = await this.coordinator.fetch(agent, body);
        if (files.length === 0) return { ok: false, code: "NOT_FOUND", path: body.paths[0]! };
        return { ok: true, kind: "files", files };
      }
      case "commit":
        if (!taskId) throw new Error("commit requires a task_id");
        return this.coordinator.commit(agent, taskId, body);
      case "done":
        if (!taskId) throw new Error("done requires a task_id");
        await this.coordinator.done(agent, taskId, body);
        return { ok: true, kind: "done" };
      case "create_tasks":
        if (!this.coordinator.createTasks) throw new Error("create_tasks is not configured");
        return { ok: true, kind: "tasks", task_ids: (await this.coordinator.createTasks(agent, body)).map((task) => task.id) };
    }
  }
}
