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
  if ("data" in root && (!root.data || typeof root.data !== "object" || Array.isArray(root.data))) {
    throw new Error("SCHEMA_INVALID");
  }
  return (root.data ?? root) as RawRecord;
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
  const projectedChildren: XydcVariantChild[] = [];
  for (const rawChild of children) {
    if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) throw new Error("SCHEMA_INVALID");
    const child = rawChild as RawRecord;
    const asin = normalizeAsin(child.asin);
    if (!asin) throw new Error("SCHEMA_INVALID");
    if (seenChildren.has(asin)) continue;
    seenChildren.add(asin);
    projectedChildren.push(pendingChild(asin, projectAttributes(child.attributes)));
  }
  const dimensions = body.dimensions === undefined
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

type XydcInformation = Omit<XydcVariantChild, "attributes" | "listingDate" | "infoStatus"> & { complete: boolean };

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

function informationRows(raw: unknown) {
  const source = Array.isArray(raw)
    ? raw
    : !raw || typeof raw !== "object"
      ? (() => { throw new Error("SCHEMA_INVALID"); })()
      : Array.isArray((raw as RawRecord).data)
        ? (raw as RawRecord).data as unknown[]
        : Array.isArray((raw as RawRecord).items)
          ? (raw as RawRecord).items as unknown[]
          : (() => { throw new Error("SCHEMA_INVALID"); })();
  const mapped = new Map<string, XydcInformation>();
  for (const row of source) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("SCHEMA_INVALID");
    const value = row as RawRecord;
    const asin = normalizeAsin(value.asin);
    const title = strictNullableString(value.title);
    const imageUrl = strictNullableImageUrl(value.imageUrl);
    const price = strictNullableNumber(value.price);
    const currency = strictNullableString(value.currency);
    const stars = strictNullableNumber(value.stars);
    const productPageRatings = strictNullableNumber(value.productPageRatings);
    if (!asin || (price !== null && price < 0)
      || (stars !== null && (stars < 0 || stars > 5)) || (productPageRatings !== null && (!Number.isInteger(productPageRatings) || productPageRatings < 0))) {
      throw new Error("SCHEMA_INVALID");
    }
    const complete = [title, imageUrl, price, currency, stars, productPageRatings].every(field => field !== null);
    mapped.set(asin, { asin, title, imageUrl, price, currency, stars, productPageRatings, complete });
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
      if (!info?.complete) return { ...child, infoStatus: "unavailable" as const };
      const { complete, ...projected } = info;
      void complete;
      return { ...child, ...projected, listingDate: null, infoStatus: "ready" as const };
    }),
  };
}

function statusFor(family: XydcVariantFamily): Pick<XydcVariantFamily, "status" | "reasonCode"> {
  if (family.status === "unavailable") return { status: "unavailable", reasonCode: family.reasonCode };
  if (family.cacheState === "stale") return { status: family.status, reasonCode: family.reasonCode };
  if (family.reasonCode === "SCHEMA_INVALID") {
    return family.children.length
      ? { status: "partial", reasonCode: "SCHEMA_INVALID" }
      : { status: "unavailable", reasonCode: "SCHEMA_INVALID" };
  }
  if (!family.children.length) return { status: "partial", reasonCode: "PARTIAL_CHILD_INFO" };
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
    ...family, ...statusFor(family), cacheState: family.cacheState,
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

function markSchemaInvalidBatch(drafts: Map<string, XydcVariantFamily>, batch: readonly string[]) {
  const affectedChildren = new Set(batch);
  for (const [inputAsin, family] of drafts) {
    if (!family.children.some(child => affectedChildren.has(child.asin))) continue;
    drafts.set(inputAsin, {
      ...family,
      children: family.children.map(child => affectedChildren.has(child.asin)
        ? { ...child, infoStatus: "unavailable" as const }
        : child),
      status: "partial",
      reasonCode: "SCHEMA_INVALID",
    });
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
    } catch (error) {
      if (reasonFor(error) === "SCHEMA_INVALID") {
        markSchemaInvalidBatch(drafts, batch);
        break;
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
