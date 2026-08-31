import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { Router } from "../router/router.js";

/** Separate private HTTP boundary; no CORS or frontend/static routes. */
export async function createTaskServerApp(config: AppConfig, router: Router): Promise<FastifyInstance> {
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
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid coordination message", details: error.issues });
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}
