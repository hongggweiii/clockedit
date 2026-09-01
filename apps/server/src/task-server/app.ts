import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { Router } from "../router/router.js";
import { SseAgentChannel } from "../router/sse-agent-channel.js";
import { eventsQuerySchema } from "../router/schemas/task-server.schemas.js";
import type { AgentProfile } from "../types.js";

/** Separate private HTTP boundary; no CORS or frontend/static routes. */
export async function createTaskServerApp(
  config: AppConfig,
  router: Router,
  resolveAgentProfile: (agentId: string) => AgentProfile | null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 1_048_576 });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const expected = Buffer.from(config.taskServerAuthToken);
    const candidate = Buffer.from(request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "");
    const valid = expected.length > 0 && candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!valid) return reply.code(401).send({ error: "Authentication required" });
  });
  app.get("/health", async () => ({ ok: true, service: "task-server" }));
  app.get("/events", async (request, reply) => {
    const { agent_id: agentId } = eventsQuerySchema.parse(request.query);
    const profile = resolveAgentProfile(agentId);
    if (!profile) {
      return reply.code(404).send({ error: "Agent not found" });
    }
    if (router.hasAgent(agentId)) {
      return reply.code(409).send({ error: "Agent is already connected" });
    }

    reply.hijack();
    const channel = new SseAgentChannel(reply.raw);
    const detach = router.registerAgent(agentId, channel, profile);
    request.raw.once("close", () => {
      detach();
      channel.close();
    });
  });
  app.post("/messages", async (request, reply) => {
    const response = await router.handleMessage(request.body);
    return response;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid coordination message", details: error.issues });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}
