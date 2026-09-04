import path from "node:path";

import {
  XydcVariantFamilySchema,
  type XydcVariantFamily,
  type XydcVariantReasonCode,
} from "../shared/xydc-variant-contract";
import { callXydcTool } from "./lib/xydc-mcp-client";
import { createXydcVariantCache, isFreshXydcVariantCache } from "./lib/xydc-variant-cache";
import { resolveRuntimeRoots } from "./lib/runtime-roots.mjs";

type Cache = {
  readMany(country: string, asins: readonly string[]): Promise<Record<string, XydcVariantFamily>>;
  write(country: string, family: XydcVariantFamily): Promise<void>;
};
type ToolCall = (input: { toolName: "get_asin_variations" | "get_asin_info"; args: Record<string, unknown> }) => Promise<unknown>;

export interface SyncXydcVariantInput {
  asins: readonly string[];
  country: string;
  token: string;
  now: Date;
  cache: Cache;
  force?: boolean;
  batchSize?: number;
  callTool?: ToolCall;
}

type RawRecord = Record<string, unknown>;
type XydcVariantChild = XydcVariantFamily["children"][number];

function normalizeAsin(value: unknown) {
  const asin = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
}

function stringOrNull(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function numberOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function record(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function variationBody(raw: unknown) {
  const root = record(raw);
  return record(root.data ?? raw);
}

function projectAttributes(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap(value => {
    const attribute = record(value);
    const dimension = stringOrNull(attribute.dimension);
    const attributeValue = stringOrNull(attribute.value);
    const key = `${dimension}\u0000${attributeValue}`;
    if (!dimension || !attributeValue || seen.has(key)) return [];
    seen.add(key);
    return [{ dimension, value: attributeValue }];
  });
}

function pendingChild(asin: string, attributes: ReturnType<typeof projectAttributes>): XydcVariantChild {
  return {
    asin, attributes, title: null, imageUrl: null, price: null, currency: null,
    stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending",
  };
}

export function projectXydcVariationFamily({
  inputAsin,
  country,
  raw,
  fetchedAt,
}: {
  inputAsin: string;
  country: string;
  raw: unknown;
  fetchedAt: string;
}): XydcVariantFamily {
  const body = variationBody(raw);
  const normalizedInput = normalizeAsin(inputAsin);
  const parentAsin = normalizeAsin(body.parentAsin);
  const children = Array.isArray(body.children) ? body.children : [];
  if (!normalizedInput || !parentAsin || !children.length) throw new Error("SCHEMA_INVALID");
  const seenChildren = new Set<string>();
  const projectedChildren = children.flatMap(rawChild => {
    const child = record(rawChild);
    const asin = normalizeAsin(child.asin);
    if (!asin || seenChildren.has(asin)) return [];
    seenChildren.add(asin);
    return [pendingChild(asin, projectAttributes(child.attributes))];
  });
  if (!projectedChildren.length) throw new Error("SCHEMA_INVALID");
  const dimensions = Array.isArray(body.dimensions)
    ? [...new Set(body.dimensions.flatMap(value => stringOrNull(value) ?? []))]
    : [...new Set(projectedChildren.flatMap(child => child.attributes.map(attribute => attribute.dimension)))];
  return XydcVariantFamilySchema.parse({
    inputAsin: normalizedInput,
    country: country.trim().toUpperCase(),
    parentAsin,
    dimensions,
    children: projectedChildren,
    sourceUpdatedAt: stringOrNull(body.sourceUpdatedAt),
    fetchedAt,
    status: "partial",
    reasonCode: "PARTIAL_CHILD_INFO",
    cacheState: "fresh",
  });
}

function informationRows(raw: unknown) {
  const root = record(raw);
  const source = Array.isArray(root.data) ? root.data : Array.isArray(root.items) ? root.items : Array.isArray(raw) ? raw : [];
  const mapped = new Map<string, Omit<XydcVariantChild, "attributes" | "listingDate" | "infoStatus">>();
  for (const row of source) {
    const value = record(row);
    const asin = normalizeAsin(value.asin);
    const title = stringOrNull(value.title);
    const imageUrl = stringOrNull(value.imageUrl);
    const price = numberOrNull(value.price);
    const currency = stringOrNull(value.currency);
    const stars = numberOrNull(value.stars);
    const productPageRatings = numberOrNull(value.productPageRatings);
    if (!asin || (imageUrl !== null && !/^https?:\/\//.test(imageUrl)) || (price !== null && price < 0)
      || (stars !== null && (stars < 0 || stars > 5)) || (productPageRatings !== null && (!Number.isInteger(productPageRatings) || productPageRatings < 0))) continue;
    mapped.set(asin, { asin, title, imageUrl, price, currency, stars, productPageRatings });
  }
  return mapped;
}

function withInformation(family: XydcVariantFamily, information: ReturnType<typeof informationRows>, requested: readonly string[]) {
  const requestedSet = new Set(requested);
  return {
    ...family,
    children: family.children.map(child => {
      if (!requestedSet.has(child.asin)) return child;
      const info = information.get(child.asin);
      return info
        ? { ...child, ...info, listingDate: null, infoStatus: "ready" as const }
        : { ...child, infoStatus: "unavailable" as const };
    }),
  };
}

function statusFor(family: XydcVariantFamily): Pick<XydcVariantFamily, "status" | "reasonCode"> {
  return family.children.every(child => child.infoStatus === "ready")
    ? { status: "ready", reasonCode: null }
    : { status: "partial", reasonCode: "PARTIAL_CHILD_INFO" };
}

function unavailableFamily(inputAsin: string, country: string, now: Date, reasonCode: XydcVariantReasonCode): XydcVariantFamily {
  return XydcVariantFamilySchema.parse({
    inputAsin, country: country.trim().toUpperCase(), parentAsin: inputAsin, dimensions: [], children: [],
    sourceUpdatedAt: null, fetchedAt: now.toISOString(), status: "unavailable", reasonCode, cacheState: "fresh",
  });
}

function reasonFor(error: unknown): XydcVariantReasonCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "NOT_CONFIGURED") return "NOT_CONFIGURED";
  if (message === "AUTH_FAILED") return "AUTH_FAILED";
  if (message === "TIMEOUT") return "TIMEOUT";
  if (message === "NOT_FOUND") return "NOT_FOUND";
  if (message === "SCHEMA_INVALID") return "SCHEMA_INVALID";
  return "RPC_ERROR";
}

export function boundedBatchSize(value: number) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : 20;
}

function chunk<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function hasRelationshipEvidence(family: XydcVariantFamily | undefined, now: Date) {
  return Boolean(family?.children.length) && now.getTime() - Date.parse(family!.fetchedAt) <= 86_400_000;
}

async function persistFamilies(input: SyncXydcVariantInput, drafts: Map<string, XydcVariantFamily>) {
  await Promise.all([...drafts.values()].map(async family => input.cache.write(input.country, XydcVariantFamilySchema.parse({
    ...family, ...statusFor(family), cacheState: "fresh",
  }))));
}

function mergeFamilies(families: readonly XydcVariantFamily[]) {
  const grouped = new Map<string, XydcVariantFamily>();
  for (const family of families) {
    const existing = grouped.get(family.parentAsin);
    if (!existing) {
      grouped.set(family.parentAsin, XydcVariantFamilySchema.parse({
        ...family,
        ...statusFor(family),
      }));
      continue;
    }
    const children = new Map(existing.children.map(child => [child.asin, child]));
    family.children.forEach(child => children.set(child.asin, child.infoStatus === "ready" ? child : children.get(child.asin) ?? child));
    grouped.set(family.parentAsin, XydcVariantFamilySchema.parse({
      ...existing,
      dimensions: [...new Set([...existing.dimensions, ...family.dimensions])],
      children: [...children.values()],
      ...statusFor({ ...existing, children: [...children.values()] }),
    }));
  }
  return [...grouped.values()];
}

export async function syncXydcVariantFamilies(input: SyncXydcVariantInput) {
  const asins = [...new Set(input.asins.map(normalizeAsin).filter((asin): asin is string => Boolean(asin)))];
  const cached = await input.cache.readMany(input.country, asins);
  if (!input.token.trim()) {
    const unavailable = asins.map(asin => unavailableFamily(asin, input.country, input.now, "NOT_CONFIGURED"));
    await Promise.all(unavailable.map(family => input.cache.write(input.country, family)));
    return mergeFamilies(unavailable);
  }
  const drafts = new Map<string, XydcVariantFamily>();
  const ready = new Set<string>();
  for (const asin of asins) {
    const prior = cached[asin];
    if (!input.force && isFreshXydcVariantCache(prior, input.now)) {
      drafts.set(asin, prior);
      ready.add(asin);
    } else if (!input.force && hasRelationshipEvidence(prior, input.now)) {
      drafts.set(asin, { ...prior, cacheState: "fresh" });
    }
  }
  const request = input.callTool ?? (async ({ toolName, args }) => callXydcTool(input.token, toolName, args));
  for (const asin of asins.filter(asin => !ready.has(asin) && (!drafts.has(asin) || input.force))) {
    try {
      const draft = projectXydcVariationFamily({
        inputAsin: asin, country: input.country,
        raw: await request({ toolName: "get_asin_variations", args: { asin, country: input.country } }),
        fetchedAt: input.now.toISOString(),
      });
      const previousByChild = new Map((cached[asin]?.children ?? []).map(child => [child.asin, child]));
      drafts.set(asin, {
        ...draft,
        children: draft.children.map(child => previousByChild.get(child.asin)?.infoStatus === "ready" ? previousByChild.get(child.asin)! : child),
      });
    } catch (error) {
      const prior = cached[asin];
      if (prior?.status === "ready") drafts.set(asin, { ...prior, cacheState: "stale" });
      else drafts.set(asin, unavailableFamily(asin, input.country, input.now, reasonFor(error)));
    }
  }
  const unresolved = [...new Set([...drafts.values()].flatMap(family => family.children.filter(child => child.infoStatus !== "ready").map(child => child.asin)))];
  for (const batch of chunk(unresolved, boundedBatchSize(input.batchSize ?? 20))) {
    try {
      const information = informationRows(await request({ toolName: "get_asin_info", args: { asins: batch, country: input.country } }));
      for (const [asin, family] of drafts) drafts.set(asin, withInformation(family, information, batch));
      await persistFamilies(input, drafts);
    } catch {
      // A later run uses the checked parent/child cache evidence and only retries these children.
    }
  }
  await persistFamilies(input, drafts);
  return mergeFamilies([...drafts.values()]);
}

export function getProjectRoot() {
  return path.resolve(import.meta.dirname, "..");
}

async function main() {
  const roots = resolveRuntimeRoots({
    codeRoot: getProjectRoot(), formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), env: process.env, commit: undefined,
  });
  const asins = (process.env.XYDC_ASINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const families = await syncXydcVariantFamilies({
    asins,
    country: process.env.XYDC_COUNTRY ?? "US",
    token: process.env.XYDC_MCP_TOKEN ?? "",
    force: process.env.FORCE_REFRESH === "1" || process.argv.includes("--force"),
    batchSize: Number(process.env.XYDC_INFO_BATCH_SIZE ?? "20"),
    now: new Date(),
    cache: createXydcVariantCache(roots.dataRoot),
  });
  process.stdout.write(`[xydc] ${families.length} family snapshots cached\n`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch(() => { process.exitCode = 1; });
}
