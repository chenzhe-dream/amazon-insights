import { createHash } from "node:crypto";

import { z } from "zod";

import { buildTrafficAnalysisConclusion } from "../../../app/traffic-analysis-conclusion";
import { sifMonthlyTrafficTrend } from "../../../app/sif-monthly-traffic-trend-data";
import { AsinSchema, DateTimeSchema, MarketplaceSchema, Sha256Schema } from "../../../shared/agent-contracts";

const trafficCapabilityBoundary =
  "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。";
const prohibitedProfitTerms = /profit(?:ability|\s+efficiency)?|roi|margin|project approval|盈利|利润|毛利|投资回报|立项/i;

export const TRAFFIC_DECISION_BOUNDARIES = Object.freeze({
  profitability: "not-assessed" as const,
  advertisingEfficiency: "requires-validation" as const,
  roi: "not-assessed" as const,
  projectApproval: "not-assessed" as const,
});

const MonthlyTrafficPointSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  natural: z.number().finite().nonnegative(),
  advertising: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative(),
});

const TrafficCompetitorSchema = z.strictObject({
  asin: AsinSchema,
  brand: z.string().trim().min(1).max(200),
  trafficRank: z.number().int().positive(),
  trafficVolume: z.number().finite().nonnegative(),
  naturalVolume: z.number().finite().nonnegative(),
  naturalShare: z.number().finite().min(0).max(100),
  advertisingVolume: z.number().finite().nonnegative(),
  advertisingShare: z.number().finite().min(0).max(100),
  top1Share: z.number().finite().min(0).max(100),
  top3Share: z.number().finite().min(0).max(100),
  hhi: z.number().finite().min(0).max(10_000),
  effectiveChildren: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
  recommendationTraffic: z.number().finite().nonnegative(),
  maxAdvertisingChannel: z.string().trim().min(1).max(200),
  maxAdvertisingChannelShare: z.number().finite().min(0).max(100),
  effectiveAdvertisingChannels: z.number().int().nonnegative(),
  pullGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  naturalGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  advertisingGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  recommendationGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  variantGrade: z.enum(["强", "中强", "中", "中弱", "弱"]),
  health: z.enum(["健康", "基本健康", "需观察", "风险较高"]),
  monthlyTrend: z.array(MonthlyTrafficPointSchema).max(24),
});

export const TrafficAnalysisInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("competitor-traffic-analysis-input"),
  marketplace: MarketplaceSchema,
  dataCutoffAt: DateTimeSchema,
  inputDigest: Sha256Schema,
  capabilityBoundary: z.literal(trafficCapabilityBoundary),
  competitors: z.array(TrafficCompetitorSchema).max(10),
});
export type TrafficAnalysisInput = z.infer<typeof TrafficAnalysisInputSchema>;

export const TrafficAnalysisOutputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("competitor-traffic-analysis"),
  status: z.enum(["complete", "partial", "unavailable"]),
  identity: z.strictObject({
    dataCutoffAt: DateTimeSchema,
    inputDigest: Sha256Schema,
  }),
  summary: z.string().trim().min(1).max(2_000),
  competitors: z.array(TrafficCompetitorSchema).max(10),
  decisionBoundaries: z.strictObject({
    profitability: z.literal("not-assessed"),
    advertisingEfficiency: z.literal("requires-validation"),
    roi: z.literal("not-assessed"),
    projectApproval: z.literal("not-assessed"),
  }),
  dataBoundary: z.literal(trafficCapabilityBoundary),
});
export type TrafficAnalysisOutput = z.infer<typeof TrafficAnalysisOutputSchema>;

export function buildDeterministicTrafficInput(input: {
  marketplace: "US";
  asins: readonly string[];
  dataCutoffAt: string;
}): TrafficAnalysisInput {
  const marketplace = MarketplaceSchema.parse(input.marketplace);
  const dataCutoffAt = DateTimeSchema.parse(input.dataCutoffAt);
  const asins = input.asins.map((asin) => AsinSchema.parse(asin));
  const conclusion = buildTrafficAnalysisConclusion(
    asins.map((asin) => ({ asin, brand: asin })),
  );
  const competitors = conclusion.overview.map((item) => ({
    asin: item.asin,
    brand: item.brand,
    trafficRank: item.trafficRank,
    trafficVolume: item.totalScore,
    naturalVolume: item.naturalScore,
    naturalShare: item.naturalRatio,
    advertisingVolume: item.adScore,
    advertisingShare: item.adRatio,
    top1Share: item.top1Share,
    top3Share: item.top3Share,
    hhi: item.hhi,
    effectiveChildren: item.effectiveChildren,
    childCount: item.childCount,
    recommendationTraffic: item.recommendScore,
    maxAdvertisingChannel: item.maxAdChannel,
    maxAdvertisingChannelShare: item.maxAdChannelRatio,
    effectiveAdvertisingChannels: item.effectiveAdChannels,
    pullGrade: item.pullGrade,
    naturalGrade: item.naturalGrade,
    advertisingGrade: item.adPlayGrade,
    recommendationGrade: item.recommendGrade,
    variantGrade: item.variantGrade,
    health: item.health,
    monthlyTrend: (sifMonthlyTrafficTrend[item.asin]?.points ?? []).map((point) => ({
      month: point.month,
      natural: point.natural,
      advertising: point.ad,
      total: point.total,
    })),
  }));
  const unsigned = {
    schemaVersion: "1.0.0" as const,
    kind: "competitor-traffic-analysis-input" as const,
    marketplace,
    dataCutoffAt,
    capabilityBoundary: trafficCapabilityBoundary,
    competitors,
  };
  return TrafficAnalysisInputSchema.parse({
    ...unsigned,
    inputDigest: createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  });
}

export function assertTrafficCapabilityLanguage(value: unknown): void {
  const serialized = JSON.stringify(
    isRecord(value) ? omitFixedBoundaries(value) : value,
  );
  const match = serialized.match(prohibitedProfitTerms);
  if (match) {
    throw new Error(
      `Traffic capability must not be represented as profit efficiency: ${match[0]}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitFixedBoundaries(value: Record<string, unknown>) {
  const claims = { ...value };
  delete claims.dataBoundary;
  delete claims.decisionBoundaries;
  return claims;
}

export function canonicalizeTrafficAnalysisOutput(
  candidate: unknown,
  input: TrafficAnalysisInput,
): TrafficAnalysisOutput {
  const parsed = TrafficAnalysisOutputSchema.parse(candidate);
  const output = TrafficAnalysisOutputSchema.parse({
    ...parsed,
    competitors: input.competitors,
    decisionBoundaries: TRAFFIC_DECISION_BOUNDARIES,
  });
  if (
    output.identity.inputDigest !== input.inputDigest ||
    new Date(output.identity.dataCutoffAt).getTime() !==
      new Date(input.dataCutoffAt).getTime()
  ) {
    throw new Error("Traffic analysis output identity conflicts with deterministic input");
  }
  assertTrafficCapabilityLanguage(output);
  return output;
}
