import type { Envelope, Response } from "./router.types.js";

export interface CoordinationMessageHandler {
  handleMessage(
    projectId: string,
    envelope: Envelope,
  ): Response | Promise<Response>;
}
