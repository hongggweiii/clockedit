import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { AgentChannel } from "./router.js";

/** AgentChannel implementation backed by a server-sent events response. */
export class SseAgentChannel implements AgentChannel {
  constructor(private readonly stream: ServerResponse) {
    stream.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    stream.write(": connected\n\n");
  }

  async send(response: Parameters<AgentChannel["send"]>[0]): Promise<void> {
    if (this.stream.destroyed || this.stream.writableEnded) {
      throw new Error("Agent event stream is closed");
    }
    const writable = this.stream.write(`data: ${JSON.stringify(response)}\n\n`);
    if (!writable) await once(this.stream, "drain");
  }

  close(): void {
    if (!this.stream.writableEnded) this.stream.end();
  }
}
