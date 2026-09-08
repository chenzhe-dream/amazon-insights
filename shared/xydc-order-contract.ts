import { z } from "zod";

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const COUNTRY_PATTERN = /^[A-Z]{2,8}$/;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function monthIndex(month: string) {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

const FiniteTimestampSchema = z.string().datetime().refine(
  value => Number.isFinite(Date.parse(value)),
  { message: "Timestamp must be finite" },
);

const SafeOrderCountSchema = z.number().nonnegative().refine(
  Number.isSafeInteger,
  { message: "Orders must be a nonnegative safe integer" },
);

export const XydcOrderWindowSchema = z.strictObject({
  startMonth: z.string().regex(MONTH_PATTERN),
  endMonth: z.string().regex(MONTH_PATTERN),
  months: z.array(z.string().regex(MONTH_PATTERN)).length(12),
}).superRefine((window, context) => {
  const start = monthIndex(window.startMonth);
  const end = monthIndex(window.endMonth);
  const indexes = window.months.map(monthIndex);
  const uniqueMonths = new Set(window.months);
  const consecutive = start !== null
    && end !== null
    && indexes.every((value, index) => value === start + index)
    && end === start + 11;
  if (
    uniqueMonths.size !== 12
    || window.months[0] !== window.startMonth
    || window.months[11] !== window.endMonth
    || !consecutive
  ) {
    context.addIssue({
      code: "custom",
      message: "Order window must contain exactly 12 unique consecutive calendar months",
    });
  }
});

export const XydcOrderReasonSchema = z.enum([
  "NOT_CONFIGURED",
  "AUTH_FAILED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "TIMEOUT",
  "CANCELLED",
  "BUDGET_EXHAUSTED",
  "RPC_ERROR",
  "SCHEMA_INVALID",
  "NOT_FOUND",
  "PARTIAL_DATA",
]);

export const XydcOrderTrendSchema = z.strictObject({
  date: z.string().regex(MONTH_PATTERN),
  orders: SafeOrderCountSchema,
});

export const XydcOrderChildSchema = z.strictObject({
  asin: z.string().regex(ASIN_PATTERN),
  trends: z.array(XydcOrderTrendSchema).max(12),
  fetchedAt: FiniteTimestampSchema,
  reasonCode: XydcOrderReasonSchema.nullable(),
});

export const XydcOrderSnapshotSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal("xydc"),
  aggregation: z.literal("children"),
  country: z.string().regex(COUNTRY_PATTERN),
  parentAsin: z.string().regex(ASIN_PATTERN),
  childAsins: z.array(z.string().regex(ASIN_PATTERN)).min(1),
  window: XydcOrderWindowSchema,
  children: z.array(XydcOrderChildSchema),
  sourceUpdatedAt: FiniteTimestampSchema.nullable(),
  fetchedAt: FiniteTimestampSchema,
  cacheState: z.enum(["fresh", "stale"]),
  reasonCode: XydcOrderReasonSchema.nullable(),
}).superRefine((snapshot, context) => {
  const expectedChildren = new Set(snapshot.childAsins);
  if (expectedChildren.size !== snapshot.childAsins.length) {
    context.addIssue({ code: "custom", path: ["childAsins"], message: "Child ASINs must be unique" });
  }

  const returnedChildren = new Set<string>();
  const allowedMonths = new Set(snapshot.window.months);
  let aggregate = BigInt(0);
  for (let childIndex = 0; childIndex < snapshot.children.length; childIndex += 1) {
    const child = snapshot.children[childIndex];
    if (returnedChildren.has(child.asin)) {
      context.addIssue({ code: "custom", path: ["children", childIndex, "asin"], message: "Returned children must be unique" });
    }
    returnedChildren.add(child.asin);
    if (!expectedChildren.has(child.asin)) {
      context.addIssue({ code: "custom", path: ["children", childIndex, "asin"], message: "Returned child is outside the bound child set" });
    }

    const trendMonths = new Set<string>();
    for (let trendIndex = 0; trendIndex < child.trends.length; trendIndex += 1) {
      const trend = child.trends[trendIndex];
      if (trendMonths.has(trend.date)) {
        context.addIssue({ code: "custom", path: ["children", childIndex, "trends", trendIndex, "date"], message: "Trend months must be unique per child" });
      }
      trendMonths.add(trend.date);
      if (!allowedMonths.has(trend.date)) {
        context.addIssue({ code: "custom", path: ["children", childIndex, "trends", trendIndex, "date"], message: "Trend month is outside the bound window" });
      }
      if (Number.isSafeInteger(trend.orders) && trend.orders >= 0) {
        aggregate += BigInt(trend.orders);
      }
    }
  }

  if (aggregate > MAX_SAFE_INTEGER_BIGINT) {
    context.addIssue({ code: "custom", path: ["children"], message: "Derived order sums must remain safe integers" });
  }
});

export type XydcOrderWindow = z.infer<typeof XydcOrderWindowSchema>;
export type XydcOrderReason = z.infer<typeof XydcOrderReasonSchema>;
export type XydcOrderChild = z.infer<typeof XydcOrderChildSchema>;
export type XydcOrderSnapshot = z.infer<typeof XydcOrderSnapshotSchema>;

export type XydcOrderSummary = {
  complete: boolean;
  total: number | null;
  returnedChildren: number;
  expectedChildren: number;
  undisclosedChildMonths: number;
  rows: {
    asin: string;
    complete: boolean;
    total: number | null;
    share: number | null;
    missingMonths: string[];
    undisclosedMonths: number;
  }[];
  months: {
    date: string;
    total: number | null;
    values: { asin: string; orders: number | null }[];
  }[];
};
