import { z } from "zod";
import { XydcOrderReasonSchema, XydcOrderWindowSchema } from "./xydc-order-contract";

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const timestamp = z.string().datetime();
export const XydcOrderProgressStateSchema = z.enum([
  "queued", "collecting", "rate-wait", "completed", "partial", "failed", "cancelled", "interrupted",
]);
export const XydcOrderJobIdentitySchema = z.strictObject({
  organizationId: id, projectId: id, runId: id, jobId: id, workerId: id,
  leaseGeneration: z.number().int().positive().safe(),
});
export type XydcOrderJobIdentity = z.infer<typeof XydcOrderJobIdentitySchema>;
export type XydcOrderReadScope = {
  organizationId: string; projectId: string; currentRunId: string | null; country: string; asins: readonly string[];
};
export const XydcOrderProgressRecordSchema = z.strictObject({
  version: z.literal(1), ...XydcOrderJobIdentitySchema.shape,
  country: z.string().regex(/^[A-Z]{2,8}$/), window: XydcOrderWindowSchema,
  families: z.array(z.strictObject({ parentAsin: asin, childAsins: z.array(asin).min(1) })).min(1),
  children: z.array(z.strictObject({ asin, state: z.enum(["ready", "cached", "failed", "pending"]), reasonCode: XydcOrderReasonSchema.nullable() })),
  state: XydcOrderProgressStateSchema, updatedAt: timestamp,
  retryAt: timestamp.nullable(), safeReason: XydcOrderReasonSchema.nullable(),
}).superRefine((record, context) => {
  const expected = new Set(record.families.flatMap(family => family.childAsins));
  if (record.children.length !== expected.size || new Set(record.children.map(child => child.asin)).size !== expected.size
    || record.children.some(child => !expected.has(child.asin))
    || record.children.some(child => (child.state === "ready" || child.state === "cached") && child.reasonCode !== null)
    || new Set(record.families.map(family => family.parentAsin)).size !== record.families.length
    || record.families.some(family => new Set(family.childAsins).size !== family.childAsins.length)
    || (record.state === "completed" && record.children.some(child => child.state !== "ready" && child.state !== "cached"))) {
    context.addIssue({ code: "custom", message: "Progress facts must match the verified family children" });
  }
});
export type XydcOrderProgressRecord = z.infer<typeof XydcOrderProgressRecordSchema>;
export const XydcOrderProgressViewSchema = z.strictObject({
  currentRunId: id, jobId: id, leaseGeneration: z.number().int().nonnegative(), activeJob: z.boolean(),
  progress: z.strictObject({
    state: XydcOrderProgressStateSchema, ready: z.number().int().nonnegative(), cached: z.number().int().nonnegative(),
    total: z.number().int().positive(), updatedAt: timestamp, retryAt: timestamp.nullable(), safeReason: XydcOrderReasonSchema.nullable(),
  }).refine(value => value.cached <= value.ready && value.ready <= value.total).nullable(),
});
export type XydcOrderProgressView = z.infer<typeof XydcOrderProgressViewSchema>;
export function isXydcOrderProgressTerminal(state: string) {
  return ["completed", "partial", "failed", "cancelled", "interrupted"].includes(state);
}
