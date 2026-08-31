import { z } from "zod";

export const eventsQuerySchema = z.strictObject({
  agent_id: z.string().trim().min(1),
});
