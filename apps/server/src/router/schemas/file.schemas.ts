import { z } from "zod";
import { hasDuplicates } from "../../utils/collections.js";


export const pathSchema = z.string().trim().min(1).max(4_096).refine((value) => !value.includes("\0"));

export const fileRefSchema = z.strictObject({ path: pathSchema, version: z.number().int().nonnegative() });

export const fileWriteSchema = z.strictObject({ path: pathSchema, content: z.string().max(1_048_576), based_on: z.number().int().nonnegative().nullable() });

export function uniquePaths<TSchema extends z.ZodTypeAny>(itemSchema: TSchema, pathOf: (value: z.output<TSchema>) => string) {
  return z.array(itemSchema).superRefine((values, context) => {
    if (hasDuplicates(values.map(pathOf))) context.addIssue({ code: "custom", message: "Each path may appear only once" });
  });
}
