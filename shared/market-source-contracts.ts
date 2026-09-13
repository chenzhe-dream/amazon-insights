import { z } from "zod";
import { MarketAnalysisScopeSchema, MarketInputRecordSchema, type MarketAnalysisScope, type ReadonlyMarketJsonValue } from "./market-analysis-contracts";

const reason = z.string().trim().min(1).max(500);
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const count = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime().transform(value => new Date(value).toISOString());
const rawUnit = z.string().max(100).refine(value => value.trim().length > 0, "Raw unit must not be blank");

export const MARKET_SOURCE_IDENTITY_FIELDS = ["marketplace", "nodeIdPath", "nodeId", "month", "asin", "keyword", "page", "currency"] as const;
export type MarketSourceIdentityField = typeof MARKET_SOURCE_IDENTITY_FIELDS[number];

export const MarketSourceIdentityValueSchemas = {
  marketplace: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  nodeIdPath: z.string().regex(/^\d+(?::\d+)*$/).max(240),
  nodeId: z.union([z.string().regex(/^\d+$/).max(80), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform(String)]),
  month: z.string().regex(/^20\d{2}-?(0[1-9]|1[0-2])$/).transform(value => value.includes("-") ? value : `${value.slice(0, 4)}-${value.slice(4)}`),
  asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/),
  keyword: z.string().trim().min(1).max(500).transform(value => value.replace(/\s+/g, " ")),
  page: count.min(1),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
};

export const MarketSourceRequestIdentitySchema = z.object({
  marketplace: MarketSourceIdentityValueSchemas.marketplace.optional(),
  nodeIdPath: MarketSourceIdentityValueSchemas.nodeIdPath.optional(),
  nodeId: MarketSourceIdentityValueSchemas.nodeId.optional(),
  month: MarketSourceIdentityValueSchemas.month.optional(),
  asin: MarketSourceIdentityValueSchemas.asin.optional(),
  keyword: MarketSourceIdentityValueSchemas.keyword.optional(),
  page: MarketSourceIdentityValueSchemas.page.optional(),
  currency: MarketSourceIdentityValueSchemas.currency.optional(),
}).strict();
export type MarketSourceRequestIdentity = z.infer<typeof MarketSourceRequestIdentitySchema>;

export const MarketSourcePayloadPathSchema = z.array(z.union([z.string().min(1).max(200), count])).min(1).max(24);
export type MarketSourcePayloadPath = z.infer<typeof MarketSourcePayloadPathSchema>;
const paths = z.array(MarketSourcePayloadPathSchema).min(1).max(2_000).optional();
export const MarketSourceResponseIdentityPathsSchema = z.object({
  marketplace: paths, nodeIdPath: paths, nodeId: paths, month: paths,
  asin: paths, keyword: paths, page: paths, currency: paths,
}).strict();

export const MarketObservationPeriodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar-months"), fromMonth: month, toMonth: month }).strict(),
  z.object({ kind: z.literal("trailing-days"), days: count.min(1), asOf: timestamp }).strict(),
  z.object({ kind: z.literal("current"), asOf: timestamp }).strict(),
  z.object({ kind: z.literal("unknown"), reason }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === "calendar-months" && value.fromMonth > value.toMonth) ctx.addIssue({ code: "custom", message: "Observation calendar period is reversed" });
});
export type MarketObservationPeriod = z.infer<typeof MarketObservationPeriodSchema>;

export const MarketSourceUnitSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), unit: z.enum(["count", "ratio", "percent", "currency"]), rawUnit, currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict(),
  z.object({ status: z.literal("unknown"), rawUnit: rawUnit.nullable(), reason }).strict(),
]).superRefine((value, ctx) => {
  if (value.status === "known" && (value.unit === "currency") !== (value.currency !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only known currency units require a currency code" });
  }
});
export type MarketSourceUnit = z.infer<typeof MarketSourceUnitSchema>;

export const MarketSourceCoverageSchema = z.object({
  receivedCount: count,
  expectedCount: count.nullable(),
  truncation: z.discriminatedUnion("status", [
    z.object({ status: z.literal("not-truncated") }).strict(),
    z.object({ status: z.literal("truncated"), reason }).strict(),
    z.object({ status: z.literal("unknown"), reason }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.expectedCount !== null && value.receivedCount > value.expectedCount) ctx.addIssue({ code: "custom", message: "Received count exceeds expected count" });
});
export type MarketSourceCoverage = z.infer<typeof MarketSourceCoverageSchema>;

/** Paths declare identity echoes, not ordinary returned items (e.g. extension keyword rows). */
export const MarketSourceEvidenceInputSchema = z.object({
  scope: MarketAnalysisScopeSchema,
  provider: z.enum(["sellerSprite", "sorftime", "sif"]),
  operation: z.string().regex(/^[a-z][a-z0-9_/]{0,99}$/),
  requestIdentity: MarketSourceRequestIdentitySchema,
  responseIdentityPaths: MarketSourceResponseIdentityPathsSchema,
  payload: MarketInputRecordSchema.shape.data,
  fetchedAt: timestamp,
  observationPeriod: MarketObservationPeriodSchema,
  units: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/), MarketSourceUnitSchema),
  coverage: MarketSourceCoverageSchema,
}).strict();
export type MarketSourceEvidenceInput = z.input<typeof MarketSourceEvidenceInputSchema>;

export type MarketSourceIdentityCheck = Readonly<{
  expected: string | number | null;
  echoes: readonly Readonly<{ path: readonly (string | number)[]; value: string | number }>[];
  missingPaths: readonly (readonly (string | number)[])[];
  status: "verified" | "unverified";
  reason: "not-echoed" | "missing-echo-path" | "no-request-identity" | null;
}>;
export type MarketSourceEvidence = Readonly<{
  schemaVersion: "market-source-evidence/v1";
  scope: Readonly<MarketAnalysisScope>;
  provider: "sellerSprite" | "sorftime" | "sif";
  operation: string;
  requestIdentity: Readonly<MarketSourceRequestIdentity>;
  responseIdentity: Readonly<Record<MarketSourceIdentityField, MarketSourceIdentityCheck>>;
  fetchedAt: string;
  payload: ReadonlyMarketJsonValue;
  payloadHash: string;
  observationPeriod: Readonly<MarketObservationPeriod>;
  units: Readonly<Record<string, Readonly<MarketSourceUnit>>>;
  coverage: Readonly<Omit<MarketSourceCoverage, "truncation"> & { truncation: Readonly<MarketSourceCoverage["truncation"]> }>;
}>;
/** Version of the persisted collector projections, independent of model configuration. */
export const MARKET_SOURCE_HANDLER_VERSION = 'market-source-handlers/v1';
