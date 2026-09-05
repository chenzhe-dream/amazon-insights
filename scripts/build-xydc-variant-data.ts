import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function variationBody(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SCHEMA_INVALID");
  const root = raw as RawRecord;
  if ("status" in root && root.status !== 200) throw new Error("SCHEMA_INVALID");
  if ("data" in root && (!root.data || typeof root.data !== "object" || Array.isArray(root.data))) {
    throw new Error("SCHEMA_INVALID");
  }
  return (root.data ?? root) as RawRecord;
}

function requiredString(value: unknown) {
  const text = stringOrNull(value);
  if (!text) throw new Error("SCHEMA_INVALID");
  return text;
}

function projectAttributes(raw: unknown) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("SCHEMA_INVALID");
  const seen = new Set<string>();
  const projected: Array<{ dimension: string; value: string }> = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SCHEMA_INVALID");
    const attribute = value as RawRecord;
    const dimension = stringOrNull(attribute.dimension);
    const attributeValue = stringOrNull(attribute.value);
    const key = `${dimension}\u0000${attributeValue}`;
    if (!dimension || !attributeValue) throw new Error("SCHEMA_INVALID");
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push({ dimension, value: attributeValue });
  }
  return projected;
}

function pendingChild(asin: string, attributes: ReturnType<typeof projectAttributes>): XydcVariantChild {
  return {
    asin, attributes, title: null, imageUrl: null, price: null, currency: null,
    stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending",
  };
}

function projectRealVariationChildren(body: RawRecord) {
  if (!Array.isArray(body.childAsins) || !Array.isArray(body.variationDistribution)) throw new Error("SCHEMA_INVALID");
  const childAsins: string[] = [];
  const childSet = new Set<string>();
  for (const value of body.childAsins) {
    const asin = normalizeAsin(value);
    if (!asin) throw new Error("SCHEMA_INVALID");
    if (childSet.has(asin)) continue;
    childSet.add(asin);
    childAsins.push(asin);
  }
  if (!childAsins.length) throw new Error("SCHEMA_INVALID");
  const attributesByAsin = new Map<string, ReturnType<typeof projectAttributes>>();
  for (const rawDistribution of body.variationDistribution) {
    if (!rawDistribution || typeof rawDistribution !== "object" || Array.isArray(rawDistribution)) throw new Error("SCHEMA_INVALID");
    const distribution = rawDistribution as RawRecord;
    const asin = normalizeAsin(distribution.asin);
    if (!asin || !childSet.has(asin) || !Array.isArray(distribution.attributes)) throw new Error("SCHEMA_INVALID");
    if (!attributesByAsin.has(asin)) attributesByAsin.set(asin, projectAttributes(distribution.attributes));
  }
  return childAsins.map(asin => pendingChild(asin, attributesByAsin.get(asin) ?? []));
}

function projectRealVariationDimensions(raw: unknown) {
  if (!Array.isArray(raw)) throw new Error("SCHEMA_INVALID");
  const dimensions = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SCHEMA_INVALID");
    const dimension = value as RawRecord;
    if (!Array.isArray(dimension.options)) throw new Error("SCHEMA_INVALID");
    dimensions.add(requiredString(dimension.dimension));
  }
  return [...dimensions];
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
  const root = raw as RawRecord;
  const body = variationBody(raw);
  const normalizedInput = normalizeAsin(inputAsin);
  const normalizedCountry = country.trim().toUpperCase();
  const parentAsin = normalizeAsin(body.parentAsin);
  const responseAsin = normalizeAsin(body.asin);
  const realContract = "childAsins" in body || "variationDimensions" in body || "variationDistribution" in body;
  if (!normalizedInput || !parentAsin) throw new Error("SCHEMA_INVALID");
  if (realContract && (
    root.status !== 200
    || responseAsin !== parentAsin
    || requiredString(body.country).toUpperCase() !== normalizedCountry
  )) throw new Error("SCHEMA_INVALID");
  const seenChildren = new Set<string>();
  const projectedChildren: XydcVariantChild[] = [];
  if (realContract) {
    projectedChildren.push(...projectRealVariationChildren(body));
    if (normalizedInput !== parentAsin && !projectedChildren.some(child => child.asin === normalizedInput)) {
      throw new Error("SCHEMA_INVALID");
    }
  } else {
    const children = Array.isArray(body.children) ? body.children : [];
    if (!children.length) throw new Error("SCHEMA_INVALID");
    for (const rawChild of children) {
      if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) throw new Error("SCHEMA_INVALID");
      const child = rawChild as RawRecord;
      const asin = normalizeAsin(child.asin);
      if (!asin) throw new Error("SCHEMA_INVALID");
      if (seenChildren.has(asin)) continue;
      seenChildren.add(asin);
      projectedChildren.push(pendingChild(asin, projectAttributes(child.attributes)));
    }
  }
  const dimensions = realContract
    ? projectRealVariationDimensions(body.variationDimensions)
    : body.dimensions === undefined
      ? [...new Set(projectedChildren.flatMap(child => child.attributes.map(attribute => attribute.dimension)))]
      : !Array.isArray(body.dimensions)
        ? (() => { throw new Error("SCHEMA_INVALID"); })()
        : [...new Set(body.dimensions.map(value => {
          const dimension = stringOrNull(value);
          if (!dimension) throw new Error("SCHEMA_INVALID");
          return dimension;
        }))];
  return XydcVariantFamilySchema.parse({
    inputAsin: normalizedInput,
    country: normalizedCountry,
    parentAsin,
    dimensions,
    children: projectedChildren,
    sourceUpdatedAt: realContract ? requiredString(body.lastUpdatedTime) : stringOrNull(body.sourceUpdatedAt),
    fetchedAt,
    status: "partial",
    reasonCode: "PARTIAL_CHILD_INFO",
    cacheState: "fresh",
  });
}

type XydcInformation = Omit<XydcVariantChild, "attributes" | "listingDate" | "infoStatus">;

function strictNullableString(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("SCHEMA_INVALID");
  return value.trim();
}

function strictNullableNumber(value: unknown) {
  if (value == null) return null;
  const number = numberOrNull(value);
  if (number === null) throw new Error("SCHEMA_INVALID");
  return number;
}

function strictNullableImageUrl(value: unknown) {
  const imageUrl = strictNullableString(value);
  if (imageUrl === null) return null;
  try {
    const url = new URL(imageUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("SCHEMA_INVALID");
    return url.href;
  } catch {
    throw new Error("SCHEMA_INVALID");
  }
}

function providerNullableString(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("SCHEMA_INVALID");
  return value.trim() || null;
}

function providerNullableNumber(value: unknown) {
  if (typeof value === "string" && !value.trim()) return null;
  return strictNullableNumber(value);
}

function providerNullableImageUrl(primary: unknown, fallback: unknown) {
  const imageUrl = providerNullableString(primary) ?? providerNullableString(fallback);
  return strictNullableImageUrl(imageUrl);
}

function informationRows(raw: unknown, country: string) {
  const root = !raw || typeof raw !== "object" || Array.isArray(raw) ? undefined : raw as RawRecord;
  if (root && "status" in root && root.status !== 200) throw new Error("SCHEMA_INVALID");
  const realContract = Boolean(root && "status" in root);
  const normalizedCountry = country.trim().toUpperCase();
  const source = Array.isArray(raw)
    ? raw
    : !root
      ? (() => { throw new Error("SCHEMA_INVALID"); })()
      : realContract
        ? !root.data || typeof root.data !== "object" || Array.isArray(root.data) || !Array.isArray((root.data as RawRecord).entities)
          ? (() => { throw new Error("SCHEMA_INVALID"); })()
          : (root.data as RawRecord).entities as unknown[]
        : Array.isArray(root.data)
          ? root.data as unknown[]
          : Array.isArray(root.items)
            ? root.items as unknown[]
            : (() => { throw new Error("SCHEMA_INVALID"); })();
  const mapped = new Map<string, XydcInformation>();
  for (const row of source) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("SCHEMA_INVALID");
    const value = row as RawRecord;
    const asin = normalizeAsin(value.asin);
    if (realContract && requiredString(value.country).toUpperCase() !== normalizedCountry) throw new Error("SCHEMA_INVALID");
    const title = realContract ? providerNullableString(value.title) : strictNullableString(value.title);
    const imageUrl = realContract
      ? providerNullableImageUrl(value.bigPicUrl, value.smallPicUrl)
      : strictNullableImageUrl(value.imageUrl);
    const price = realContract ? providerNullableNumber(value.price) : strictNullableNumber(value.price);
    const currency = realContract ? providerNullableString(value.currency) : strictNullableString(value.currency);
    const stars = realContract ? providerNullableNumber(value.stars) : strictNullableNumber(value.stars);
    const productPageRatings = realContract
      ? providerNullableNumber(value.ratings)
      : strictNullableNumber(value.productPageRatings);
    if (!asin || (price !== null && price < 0)
      || (stars !== null && (stars < 0 || stars > 5)) || (productPageRatings !== null && (!Number.isInteger(productPageRatings) || productPageRatings < 0))) {
      throw new Error("SCHEMA_INVALID");
    }
    mapped.set(asin, { asin, title, imageUrl, price, currency, stars, productPageRatings });
  }
  return mapped;
}

function withInformation(family: XydcVariantFamily, information: ReturnType<typeof informationRows>, requested: readonly string[]) {
  const requestedSet = new Set(requested);
  return {
    ...family,
    children: family.children.map(child => {
      if (!requestedSet.has(child.asin) || child.infoStatus === "ready") return child;
      const info = information.get(child.asin);
      if (!info) return { ...child, infoStatus: "unavailable" as const };
      const projected = info;
      const enriched = {
        ...child,
        ...projected,
        title: projected.title ?? child.title,
        imageUrl: projected.imageUrl ?? child.imageUrl,
        price: projected.price ?? child.price,
        currency: projected.currency ?? child.currency,
        stars: projected.stars ?? child.stars,
        productPageRatings: projected.productPageRatings ?? child.productPageRatings,
      };
      const enrichedComplete = [enriched.title, enriched.imageUrl, enriched.price, enriched.currency, enriched.stars, enriched.productPageRatings].every(field => field !== null);
      return { ...enriched, listingDate: null, infoStatus: enrichedComplete ? "ready" as const : "unavailable" as const };
    }),
  };
}

function statusFor(family: XydcVariantFamily): Pick<XydcVariantFamily, "status" | "reasonCode"> {
  if (!family.children.length) {
    return family.status === "unavailable" || family.reasonCode === "SCHEMA_INVALID"
      ? { status: "unavailable", reasonCode: family.reasonCode }
      : { status: "partial", reasonCode: "PARTIAL_CHILD_INFO" };
  }
  if (family.children.every(child => child.infoStatus === "ready")) return { status: "ready", reasonCode: null };
  return family.reasonCode === "SCHEMA_INVALID"
    ? { status: "partial", reasonCode: "SCHEMA_INVALID" }
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
    ...family, ...statusFor(family), cacheState: family.cacheState,
  }))));
}

function evidenceTime(value: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareFamilyEvidence(left: XydcVariantFamily, right: XydcVariantFamily) {
  const leftHasRelationship = left.children.length > 0;
  const rightHasRelationship = right.children.length > 0;
  if (leftHasRelationship !== rightHasRelationship) return leftHasRelationship ? -1 : 1;
  const leftFreshRelationship = leftHasRelationship && left.cacheState === "fresh";
  const rightFreshRelationship = rightHasRelationship && right.cacheState === "fresh";
  if (leftFreshRelationship !== rightFreshRelationship) return leftFreshRelationship ? -1 : 1;
  const sourceDifference = evidenceTime(right.sourceUpdatedAt) - evidenceTime(left.sourceUpdatedAt);
  if (sourceDifference) return sourceDifference;
  const fetchedDifference = evidenceTime(right.fetchedAt) - evidenceTime(left.fetchedAt);
  if (fetchedDifference) return fetchedDifference;
  return left.inputAsin.localeCompare(right.inputAsin);
}

function mergeFamilies(families: readonly XydcVariantFamily[]) {
  const grouped = new Map<string, XydcVariantFamily[]>();
  for (const family of families) {
    const key = `${family.country}:${family.parentAsin}`;
    grouped.set(key, [...(grouped.get(key) ?? []), family]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    const ordered = [...group].sort(compareFamilyEvidence);
    const winner = ordered[0]!;
    const children = new Map<string, XydcVariantFamily["children"][number]>();
    for (const family of ordered) {
      for (const child of family.children) {
        const existing = children.get(child.asin);
        if (!existing || (child.infoStatus === "ready" && existing.infoStatus !== "ready")) children.set(child.asin, child);
      }
    }
    const mergedChildren = [...children.values()];
    const schemaInvalid = ordered.some(family => family.children.length > 0 && family.reasonCode === "SCHEMA_INVALID");
    const merged = {
      ...winner,
      dimensions: [...new Set(group.flatMap(family => family.dimensions))].sort(),
      children: mergedChildren,
      status: mergedChildren.length ? "partial" as const : winner.status,
      reasonCode: schemaInvalid ? "SCHEMA_INVALID" as const : winner.reasonCode,
    };
    return XydcVariantFamilySchema.parse({ ...merged, ...statusFor(merged) });
  });
}

function markSchemaInvalidBatch(drafts: Map<string, XydcVariantFamily>, batch: readonly string[]) {
  const affectedChildren = new Set(batch);
  for (const [inputAsin, family] of drafts) {
    if (!family.children.some(child => affectedChildren.has(child.asin) && child.infoStatus !== "ready")) continue;
    drafts.set(inputAsin, {
      ...family,
      children: family.children.map(child => affectedChildren.has(child.asin) && child.infoStatus !== "ready"
        ? { ...child, infoStatus: "unavailable" as const }
        : child),
      status: "partial",
      reasonCode: "SCHEMA_INVALID",
    });
  }
}

function restoreForcedReadyFallbacks(
  input: SyncXydcVariantInput,
  cached: Record<string, XydcVariantFamily>,
  drafts: Map<string, XydcVariantFamily>,
  batch: readonly string[],
) {
  if (!input.force) return;
  const affectedChildren = new Set(batch);
  const expectedCountry = input.country.trim().toUpperCase();
  for (const [asin, family] of drafts) {
    const prior = cached[asin];
    if (prior?.status !== "ready" || prior.inputAsin !== asin || prior.country !== expectedCountry
      || !family.children.some(child => affectedChildren.has(child.asin) && child.infoStatus !== "ready")) continue;
    drafts.set(asin, { ...prior, cacheState: "stale" });
  }
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
        children: draft.children.map(child => !input.force && previousByChild.get(child.asin)?.infoStatus === "ready" ? previousByChild.get(child.asin)! : child),
      });
    } catch (error) {
      const prior = cached[asin];
      if (prior?.status === "ready") drafts.set(asin, { ...prior, cacheState: "stale" });
      else drafts.set(asin, unavailableFamily(asin, input.country, input.now, reasonFor(error)));
    }
  }
  const unresolved = [...new Set([...drafts.values()].flatMap(family => family.children.filter(child => child.infoStatus !== "ready").map(child => child.asin)))];
  for (const queuedBatch of chunk(unresolved, boundedBatchSize(input.batchSize ?? 20))) {
    const batch = queuedBatch.filter(childAsin => [...drafts.values()].some(family => family.children.some(child => child.asin === childAsin && child.infoStatus !== "ready")));
    if (!batch.length) continue;
    try {
      const information = informationRows(
        await request({ toolName: "get_asin_info", args: { asins: batch, country: input.country } }),
        input.country,
      );
      for (const [asin, family] of drafts) drafts.set(asin, withInformation(family, information, batch));
      await persistFamilies(input, drafts);
    } catch (error) {
      restoreForcedReadyFallbacks(input, cached, drafts, batch);
      if (reasonFor(error) === "SCHEMA_INVALID") {
        markSchemaInvalidBatch(drafts, batch);
        continue;
      }
      // A later run uses the checked parent/child cache evidence and only retries these children.
    }
  }
  await persistFamilies(input, drafts);
  return mergeFamilies([...drafts.values()]);
}

export function getProjectRoot() {
  return path.resolve(import.meta.dirname, "..");
}

async function fixtureToolCall(fixturePath: string, toolName: "get_asin_variations" | "get_asin_info") {
  if (process.env.NODE_ENV !== "test") throw new Error("NOT_CONFIGURED");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  if (!(toolName in fixture)) throw new Error("SCHEMA_INVALID");
  return fixture[toolName];
}

async function main() {
  const roots = resolveRuntimeRoots({
    codeRoot: getProjectRoot(), formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), env: process.env, commit: undefined,
  });
  const asins = (process.env.XYDC_ASINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const fixturePath = process.env.XYDC_FIXTURE_PATH?.trim();
  const families = await syncXydcVariantFamilies({
    asins,
    country: process.env.XYDC_COUNTRY ?? "US",
    token: process.env.XYDC_MCP_TOKEN ?? "",
    force: process.env.FORCE_REFRESH === "1" || process.argv.includes("--force"),
    batchSize: Number(process.env.XYDC_INFO_BATCH_SIZE ?? "20"),
    now: new Date(),
    cache: createXydcVariantCache(roots.dataRoot),
    ...(fixturePath ? { callTool: async ({ toolName }) => fixtureToolCall(fixturePath, toolName) } : {}),
  });
  process.stdout.write(`[xydc] ${families.length} family snapshots cached\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}
