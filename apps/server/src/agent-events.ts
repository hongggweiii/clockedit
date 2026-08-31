import { responseSchema } from "./router/schemas/router.schemas.js";
import type { Response as ProtocolResponse } from "./router/router.types.js";

export interface AgentEventsConnection {
  close(): void;
  settled: Promise<void>;
}

interface AgentEventsOptions {
  baseUrl: string;
  agentId: string;
  authToken?: string;
  onMessage(message: ProtocolResponse): void | Promise<void>;
}

/** Open the agent's long-lived server-sent-events connection. */
export async function openAgentEvents(options: AgentEventsOptions): Promise<AgentEventsConnection> {
  const controller = new AbortController();
  const endpoint = new URL(
    `events?agent_id=${encodeURIComponent(options.agentId)}`,
    options.baseUrl.endsWith("/") ? options.baseUrl : options.baseUrl + "/",
  );
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (options.authToken) headers.authorization = `Bearer ${options.authToken}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(`Coordination SSE connection failed with status ${response.status}`);
  }
  if (!response.body) throw new Error("Coordination SSE response has no body");

  const reader = response.body.getReader();
  const settled = consumeEvents(reader, options.onMessage, controller.signal)
    .finally(() => reader.releaseLock());

  return {
    close: () => controller.abort(),
    settled,
  };
}

async function consumeEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onMessage: AgentEventsOptions["onMessage"],
  signal: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0) {
            const message = responseSchema.parse(JSON.parse(dataLines.join("\n")));
            await onMessage(message);
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
