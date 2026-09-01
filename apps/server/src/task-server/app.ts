import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { Router } from "../router/router.js";
import type { EventListener } from "./sse-broadcast-adapter.js";

export interface EventSource {
  subscribe(listener: EventListener): () => void;
}

/** Separate private HTTP boundary; no CORS or frontend/static routes. */
export async function createTaskServerApp(
  config: AppConfig,
  router: Router,
  eventSource?: EventSource,
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
  app.get("/tasks", async () => ({
    tasks: await router.getTasks(),
  }));
  app.post("/messages", async (request, reply) => {
    const response = await router.handleMessage(request.body);
    return response;
  });

  if (eventSource) {
    // Server-sent events: server → agent push channel. Runners subscribe here
    // to receive task_assigned events and spawn Codex per task.
    app.get("/events", async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");

      const unsubscribe = eventSource.subscribe((event) => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event.kind}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      const keepAlive = setInterval(() => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(": heartbeat\n\n");
      }, 15_000);

      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      };
      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid coordination message", details: error.issues });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}
