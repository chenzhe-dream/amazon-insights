import { z } from "zod";

export const SellingTranslationParams = z.object({ projectId: z.string().uuid(), asin: z.string().regex(/^[A-Z0-9]{10}$/) }).strict();
export const SellingTranslationEmpty = z.object({}).strict();
export const SellingTranslationStartRequest = z.object({ versionId: z.string().uuid().optional() }).strict();
export const SellingTranslationReadQuery = z.object({ versionId: z.string().uuid().optional() }).strict();
export const SellingTranslationResponse = z.object({
  asin: z.string(), sourceHash: z.string(), state: z.enum(["missing", "pending", "ready", "failed", "unavailable"]),
  points: z.array(z.string()), original: z.array(z.string()), sourceComplete: z.boolean(),
  message: z.string().nullable(),
}).strict();
export type SellingTranslationResult = z.infer<typeof SellingTranslationResponse>;
