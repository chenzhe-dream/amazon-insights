import { z } from "zod";
import { USAGE_PAGES, USAGE_ACTIONS } from "./usage-page-catalog";
export const USAGE_REPORT_INTERVAL_MS = 600_000;
export const RECENT_ACTIVITY_WINDOW_MS = 900_000;
export const USAGE_IDLE_THRESHOLD_MS = 300_000;
export const USAGE_MAX_AGE_MS = 86_400_000;
const page = z.enum(Object.keys(USAGE_PAGES) as [keyof typeof USAGE_PAGES, ...(keyof typeof USAGE_PAGES)[]]);
const stamp = z.iso.datetime({offset:true});
const base = {eventId:z.uuid(),pageKey:page};
export const UsageEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({...base,kind:z.literal("visit"),at:stamp}),
  z.strictObject({...base,kind:z.literal("click"),at:stamp,actionKey:z.enum(USAGE_ACTIONS),count:z.number().int().min(1).max(10000)}),
  z.strictObject({...base,kind:z.literal("duration"),metric:z.enum(["visible","active"]),startedAt:stamp,endedAt:stamp})
    .refine(e=>Date.parse(e.endedAt)>Date.parse(e.startedAt)&&Date.parse(e.endedAt)-Date.parse(e.startedAt)<=USAGE_REPORT_INTERVAL_MS,"Invalid duration"),
]);
export const UsageBatchSchema = z.strictObject({
  version:z.literal(1),tabId:z.uuid(),accountKey:z.string().min(1).max(500),observedAt:stamp,events:z.array(UsageEventSchema).max(256),
}).refine(b=>new Set(b.events.map(e=>e.eventId)).size===b.events.length,"Duplicate event IDs");
export const UsageAckSchema = z.strictObject({status:z.literal("recorded"),acknowledgedEventIds:z.array(z.uuid()).max(256),receivedAt:stamp});
export const UsageActivityResponseSchema = z.strictObject({ok:z.literal(true),usage:z.union([UsageAckSchema,z.strictObject({status:z.literal("not_bound")})]).optional()});
export const UsageQuerySchema = z.strictObject({
  period:z.enum(["day","week","month"]).default("day"),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId:z.string().min(1).max(200).optional(),pageKey:page.optional(),
});
export const UsagePersonSchema = z.object({userId:z.string(),displayName:z.string(),personLabel:z.string(),bindingStatus:z.literal("dingtalk")});
export type UsageEvent=z.infer<typeof UsageEventSchema>;
export type UsageBatch=z.infer<typeof UsageBatchSchema>;
export type UsageQuery=z.infer<typeof UsageQuerySchema>;
export type UsagePerson=z.infer<typeof UsagePersonSchema>;
export type UsageScope={organizationId:string;userId:string;sessionId:string};
export type UsageAck={acknowledgedEventIds:string[];receivedAt:string};
export type UsageTotals={visits:number;clicks:number;visibleMs:number;activeMs:number;userCount:number};
export type UsageMetrics=Omit<UsageTotals,"userCount">;
export type UsageReport={
  range:{start:string;end:string};asOf:string;timeZone:"Asia/Shanghai";collectionStartedAt:string|null;
  totals:UsageTotals;
  users:(UsagePerson&UsageMetrics&{lastActivityAt:string|null;lastPageKey:string|null})[];
  pages:(UsageMetrics&{pageKey:string;userCount:number})[];
};
export const usageEmptyMetrics=():UsageMetrics=>({visits:0,clicks:0,visibleMs:0,activeMs:0});
const metrics={visits:z.number().nonnegative(),clicks:z.number().nonnegative(),visibleMs:z.number().nonnegative(),activeMs:z.number().nonnegative()};
export const UsagePeopleResponseSchema=z.object({people:z.array(UsagePersonSchema),hasMore:z.boolean()});
export const UsageReportSchema=z.object({
  range:z.object({start:stamp,end:stamp}),asOf:stamp,timeZone:z.literal("Asia/Shanghai"),collectionStartedAt:stamp.nullable(),
  totals:z.object({...metrics,userCount:z.number().int().nonnegative()}),
  users:z.array(UsagePersonSchema.extend({...metrics,lastActivityAt:stamp.nullable(),lastPageKey:z.string().nullable()})),
  pages:z.array(z.object({...metrics,pageKey:z.string(),userCount:z.number().int().nonnegative()})),
});
