import { z } from "zod";
import { hasDuplicates } from "../../utils/collections.js";

export const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes")
  .refine((value) => !value.includes("\\"), "Path must use forward slashes")
  .refine((value) => !value.startsWith("/"), "Path must be relative")
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (segment) =>
            segment !== "" && segment !== "." && segment !== "..",
        ),
    "Path must not contain empty or relative segments",
  );

const fileVersionSchema = z.number().int().nonnegative();

export const fileRefSchema = z.strictObject({
  path: pathSchema,
  version: fileVersionSchema,
});

export const fileWriteSchema = z.strictObject({
  path: pathSchema,
  content: z.string().max(1_048_576),
  based_on: fileVersionSchema.nullable(),
  delete: z.boolean().optional(),
});

export function uniquePaths<TSchema extends z.ZodTypeAny>(
  itemSchema: TSchema,
  pathOf: (value: z.output<TSchema>) => string,
) {
  return z.array(itemSchema).superRefine((values, context) => {
    if (hasDuplicates(values.map(pathOf))) {
      context.addIssue({
        code: "custom",
        message: "Each path may appear only once",
      });
    }
  });
}
