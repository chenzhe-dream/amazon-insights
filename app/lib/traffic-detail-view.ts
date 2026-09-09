export type TrafficDetailScope = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
  marketplace: string;
  asin: string;
  evidenceId: string;
}>;

export function sameTrafficDetailScope(
  expected: TrafficDetailScope,
  candidate: TrafficDetailScope | null | undefined,
): boolean {
  if (!candidate) return false;
  const keys = ["organizationId", "projectId", "runId", "jobId", "marketplace", "asin", "evidenceId"] as const;
  return keys.every(key => typeof expected[key] === "string" && expected[key].trim().length > 0 && expected[key] === candidate[key]);
}

import type { ChildTrafficVariant, TrafficDisplayOverview, TrafficDistributionItem, TrafficDisplayItem } from "../sif-listing-traffic-data";
import type { StageOutputSnapshot } from "./stage-output-browser";

export type TrafficFieldState = "complete" | "empty" | "missing" | "invalid";
export function formatTrafficScore(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString("en-US") : "—";
}
export function formatTrafficPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value.toFixed(1)}%` : "—";
}
export function trafficDetailMessage(state: TrafficFieldState = "missing"): string {
  return state === "empty" ? "已返回，无符合条件的明细" : state === "invalid" ? "数据格式异常，明细待补齐" : "明细待补齐";
}
export function trafficChildCountLabel(data: TrafficDisplayOverview | null | undefined, state: TrafficFieldState = "missing"): string {
  if (state === "complete" || state === "empty") return `${data?.children.length ?? 0} 个子体`;
  return data?.childCount !== undefined && data.childCount > 0 ? `已识别 ${data.childCount} 个子体，明细待补齐` : "子体数据待补齐";
}
export type TrafficDetailAvailability = Record<"adChannels" | "recommendationSources" | "children", TrafficFieldState>;
export const missingTrafficDetails = (): TrafficDetailAvailability => ({ adChannels: "missing", recommendationSources: "missing", children: "missing" });
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const recordOf = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const percent = (value: unknown): value is number => nonnegative(value) && value <= 100;
function validDistribution(value: unknown): value is TrafficDistributionItem {
  const item = recordOf(value);
  return Boolean(item && typeof item.label === "string" && nonnegative(item.score) && percent(item.ratio));
}
function validChild(value: unknown): value is ChildTrafficVariant {
  const item = recordOf(value);
  return Boolean(item && typeof item.asin === "string" && /^[A-Z0-9]{10}$/.test(item.asin)
    && typeof item.label === "string" && typeof item.image === "string" && percent(item.sharePct)
    && ["totalScore", "organic", "sp", "spRecommend", "sb", "sbv"].every(key => nonnegative(item[key])));
}

/** This merges only already scoped view data. It never discovers or reads caches. */
export function mergeTrafficRecord(input: unknown, prior?: TrafficDisplayOverview | null, priorState?: TrafficDetailAvailability) {
  const record = recordOf(input);
  const availability = missingTrafficDetails();
  if (!record) return { overview: null, availability: { adChannels: "invalid", recommendationSources: "invalid", children: "invalid" } as TrafficDetailAvailability };
  function list<T>(key: keyof TrafficDetailAvailability | "naturalAd", previous: T[] | undefined, valid: (item: unknown) => item is T): T[] {
    if (!hasOwn(record!, key)) {
      if (key !== "naturalAd") availability[key] = priorState?.[key] ?? (previous ? previous.length ? "complete" : "empty" : "missing");
      return previous ?? [];
    }
    const value = record![key];
    const validArray = Array.isArray(value) && value.every(valid);
    if (key !== "naturalAd") availability[key] = !validArray ? "invalid" : value.length ? "complete" : "empty";
    return validArray ? value : [];
  }
  const scalar = (keys: string[], previous: number | null | undefined) => {
    const key = keys.find(key => hasOwn(record, key));
    return key ? nonnegative(record[key]) ? record[key] : null : previous ?? null;
  };
  const totalScore = scalar(["totalScore", "total"], prior?.totalScore);
  let naturalAd: TrafficDisplayItem[] = list<TrafficDisplayItem>("naturalAd", prior?.naturalAd, validDistribution);
  if (!hasOwn(record, "naturalAd") && ["natural", "advertising"].some(key => hasOwn(record, key))) {
    naturalAd = ["自然流量", "广告流量"].map((label, index) => {
      const key = index === 0 ? "natural" : "advertising";
      const previous = prior?.naturalAd.find(item => item.label === label);
      const score = scalar([key], previous?.score);
      const ratio = !hasOwn(record, key) ? previous?.ratio ?? null
        : score === null || totalScore === null ? null
          : totalScore === 0 ? score === 0 ? 0 : null : score / totalScore * 100;
      return { label, score, ratio };
    });
  }
  const adChannels = list("adChannels", prior?.adChannels, validDistribution);
  const recommendationSources = list("recommendationSources", prior?.recommendationSources, validDistribution);
  const children = list("children", prior?.children, validChild);
  const suppliedCount = scalar(["childCount"], prior?.childCount);
  const childCount = hasOwn(record, "children") && availability.children !== "invalid" ? children.length
    : suppliedCount !== null && Number.isSafeInteger(suppliedCount) ? suppliedCount : undefined;
  const updatedThrough = hasOwn(record, "updatedThrough")
    ? typeof record.updatedThrough === "string" ? record.updatedThrough : null : prior?.updatedThrough ?? null;
  return { overview: { totalScore, naturalAd, adChannels, recommendationSources, children, childCount, updatedThrough }, availability };
}

/** A receipt is captured by the callback belonging to the authorized request owner. */
export type TrafficStageReceipt = Readonly<{ scopeKey: string; snapshot: StageOutputSnapshot }>;
export function trafficStageFromReceipt(receipt: TrafficStageReceipt | null, expected: {
  scopeKey: string; projectId: string | null; runId: string | null; jobId: string | null; enabled: boolean;
}): StageOutputSnapshot {
  if (!expected.enabled || !receipt || receipt.scopeKey !== expected.scopeKey) return {};
  const projection = receipt.snapshot.traffic;
  if (!projection || !("data" in projection) || projection.stage !== "traffic"
    || !expected.projectId || !expected.runId || !expected.jobId
    || projection.projectId !== expected.projectId || projection.runId !== expected.runId || projection.jobId !== expected.jobId) return {};
  return { traffic: projection };
}
