import { z } from "zod";
import {MarketSiteSchema,MarketCurrencySchema,marketSiteCurrencyMatches} from './market-sites';

export type MarketJsonValue = null | boolean | number | string | MarketJsonValue[] | { [key: string]: MarketJsonValue };

/** Source payloads must be bounded, plain JSON, without accessors or serialization hooks. */
function isPlainJson(value: unknown): value is MarketJsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 50_000 || depth > 24) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 1_000_000;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    ancestors.add(item);
    let valid = true;
    if (Array.isArray(item)) {
      // Dense own indices plus the built-in length are the only permitted keys.
      // Reflect includes hidden properties, which Object.keys would silently miss.
      if (Reflect.ownKeys(item).length !== item.length + 1) valid = false;
      for (let i = 0; valid && i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        valid = !!descriptor && descriptor.enumerable === true && "value" in descriptor && visit(descriptor.value, depth + 1);
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !("value" in descriptor) || !visit(descriptor.value, depth + 1)) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0);
}

const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** This identity is supplied after service authorization; it is not an authorization mechanism. */
export const MarketAnalysisScopeSchema = z.object({
  organizationId: identifier,
  researchId: z.string().uuid(),
  marketplace: MarketSiteSchema,
  nodeIdPath: z.string().regex(/^\d+(?::\d+)*$/).max(240),
  fromMonth: month,
  toMonth: month,
  currency: MarketCurrencySchema,
}).strict().refine(value => value.fromMonth <= value.toMonth, "Research period is reversed").refine(marketSiteCurrencyMatches,'Market currency differs from marketplace');
export type MarketAnalysisScope = z.infer<typeof MarketAnalysisScopeSchema>;

export const MarketInputRecordSchema = z.object({
  id: identifier,
  scope: MarketAnalysisScopeSchema,
  data: z.custom<MarketJsonValue>(isPlainJson, "Source data must be bounded plain JSON with finite numbers"),
}).strict();

export const MarketInputSnapshotInputSchema = z.object({
  scope: MarketAnalysisScopeSchema,
  kind: z.enum(["products", "keywords", "customer-themes", "overview"]),
  sourceVersion: z.string().trim().min(1).max(160),
  ruleVersion: z.string().trim().min(1).max(100),
  collectedAt: z.string().datetime(),
  expectedRecordIds: z.array(identifier).max(2_000),
  records: z.array(MarketInputRecordSchema).max(2_000),
}).strict();
export type MarketInputSnapshotInput = z.infer<typeof MarketInputSnapshotInputSchema>;

export type ReadonlyMarketJsonValue = null | boolean | number | string
  | readonly ReadonlyMarketJsonValue[] | { readonly [key: string]: ReadonlyMarketJsonValue };

export type MarketInputSnapshot = Readonly<{
  schemaVersion: "market-input/v1";
  snapshotId: string;
  contentHash: string;
  scope: Readonly<MarketAnalysisScope>;
  kind: MarketInputSnapshotInput["kind"];
  sourceVersion: string;
  ruleVersion: string;
  collectedAt: string;
  expectedRecordIds: readonly string[];
  records: readonly Readonly<{ id: string; scope: Readonly<MarketAnalysisScope>; data: ReadonlyMarketJsonValue }>[];
  /** Member coverage only; typed collectors must separately validate usable metrics and source periods. */
  coverage: Readonly<{
    status: "complete" | "partial" | "empty";
    expectedCount: number;
    availableCount: number;
    missingRecordIds: readonly string[];
  }>;
}>;
