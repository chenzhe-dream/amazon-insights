import { z } from "zod";

const selectedAsins = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(10)
  .refine(values => new Set(values).size === values.length);
export const VocAutomationRequestSchema = z.strictObject({
  baseSyncRunId: z.uuid(), selectedAsins,
  retryKey: z.uuid().optional(),
});
export const VocAutomationStatusSchema = z.strictObject({
  projectId: z.uuid(), baseSyncRunId: z.uuid(), selectedAsins,
  state: z.enum(["waiting-voc", "waiting-keywords", "queued", "voc-running", "definition-running", "succeeded", "failed"]),
  runId: z.uuid().nullable(), message: z.string(),
  updatedAt: z.iso.datetime({ offset: true }), startedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type VocAutomationRequest = z.infer<typeof VocAutomationRequestSchema>;
export type VocAutomationStatus = z.infer<typeof VocAutomationStatusSchema>;
