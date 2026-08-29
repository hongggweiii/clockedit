import { z } from "zod";
import { hasDuplicates } from "../../utils/collections.js";
import { pathSchema } from "./file.schemas.js";

const nonEmptyStringSchema = z.string().trim().min(1);
export const taskIdSchema = nonEmptyStringSchema.max(256);

export const taskStateSchema = z.enum(["unassigned", "blocked", "assigned", "escalated", "done"]);

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  detail: z.string().trim().min(1).max(10_000),
  state: taskStateSchema,
  owner: z.string().trim().min(1).max(256).nullable(),
  depends_on: z.array(taskIdSchema).max(256).superRefine((values, context) => { if (hasDuplicates(values)) context.addIssue({ code: "custom", message: "A dependency may be listed only once" }); }),
  writes: z.array(pathSchema).max(256).superRefine((values, context) => { if (hasDuplicates(values)) context.addIssue({ code: "custom", message: "A write intent may be listed only once" }); }),
  strikes: z.number().int().min(0).max(3),
});

export const newTaskSchema = taskSchema.omit({ state: true, strikes: true });
  
