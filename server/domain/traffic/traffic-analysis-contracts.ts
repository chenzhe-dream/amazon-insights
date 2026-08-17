import { createHash } from "node:crypto";

import { z } from "zod";

import { buildTrafficAnalysisConclusion } from "../../../app/traffic-analysis-conclusion";
import { AsinSchema, DateTimeSchema, MarketplaceSchema, Sha256Schema } from "../../../shared/agent-contracts";

const trafficCapabilityBoundary =
  "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。";
const prohibitedProfitTerms = /profit(?:ability|\s+efficiency)?|roi|margin|project approval|盈利|利润|毛利|投资回报|立项/i;

const TrafficCompetitorSchema = z.strictObject({
  asin: AsinSchema,
  brand: z.string().trim().min(1).max(200),
  trafficVolume: z.number().finite().nonnegative(),
  naturalShare: z.number().finite().min(0).max(100),
  advertisingShare: z.number().finite().min(0).max(100),
  top1Share: z.number().finite().min(0).max(100),
  concentration: z.number().int().nonnegative(),
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
    trafficVolume: item.totalScore,
    naturalShare: item.naturalRatio,
    advertisingShare: item.adRatio,
    top1Share: item.top1Share,
    concentration: item.effectiveChildren,
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
    isRecord(value) ? omitDataBoundary(value) : value,
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

function omitDataBoundary(value: Record<string, unknown>) {
  const { dataBoundary: _dataBoundary, ...claims } = value;
  return claims;
}

export function canonicalizeTrafficAnalysisOutput(
  candidate: unknown,
  input: TrafficAnalysisInput,
): TrafficAnalysisOutput {
  const output = TrafficAnalysisOutputSchema.parse(candidate);
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
