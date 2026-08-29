import type { z } from "zod";
import { fileRefSchema, fileWriteSchema } from "../router/schemas/file.schemas.js";

export type FileRef = z.infer<typeof fileRefSchema>;
export type FileWrite = z.infer<typeof fileWriteSchema>;
