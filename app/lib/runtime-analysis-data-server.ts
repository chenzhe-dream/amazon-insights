import "server-only";

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { generatedAppDataPath } from "../../scripts/lib/generated-app-data-path.mjs";

import { z } from "zod";

import { AsinSchema, EntityIdSchema, GetProjectResponseSchema } from "../../shared/agent-contracts";
import { getProjectRoot } from "../../scripts/lib/project-root.mjs";
import { readCachedArrayExport } from "../../scripts/lib/sync-cache.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import { readXydcOrderDisplaySnapshot } from "../../scripts/lib/xydc-order-display-cache";
import { xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import { readXydcTranslatedAttribute } from "../../scripts/lib/xydc-label-translation";
import { XydcOrderSnapshotSchema, type XydcOrderSnapshot, type XydcOrderWindow } from "../../shared/xydc-order-contract";
import { selectXydcOrderDisplaySnapshot } from "../../shared/xydc-order-display";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import { XydcVariantFamilySchema, type XydcVariantFamily } from "../../shared/xydc-variant-contract";
import type { XydcOrderReadScope, XydcOrderProgressView } from "../../shared/xydc-order-progress";
import { createXydcJobAuthority, createXydcProgressPool, readXydcOrderProgress } from "../../scripts/lib/xydc-order-job-progress";
import { resolveRuntimeRoots } from "../../scripts/lib/runtime-roots.mjs";
import type { AgentServiceClient } from "./agent-service-client";
import {
  RuntimeAnalysisDataSnapshotSchema,
  type RuntimeAnalysisDataSnapshot,
  type RuntimeAnalysisDataSnapshotInput,
} from "./runtime-analysis-data";

type RuntimeAnalysisDataDependencies = Readonly<{
  client: AgentServiceClient;
  readSnapshot: (asins: readonly string[], country: string) => RuntimeAnalysisDataSnapshotInput;
  readStrictSnapshot?: (asins: readonly string[], country: string) => RuntimeAnalysisDataSnapshotInput;
  readProgress?: (scope: XydcOrderReadScope, families: readonly XydcVariantFamily[]) => Promise<XydcOrderProgressView | null>;
}>;

const RuntimeAnalysisDataQuerySchema = z.strictObject({
  projectId: EntityIdSchema,
  asins: z.array(AsinSchema).min(3).max(10).refine(values => new Set(values).size === values.length),
});

const catalogPath = generatedAppDataPath(getProjectRoot(), "competitor-data.ts");

export async function readGeneratedXydcOrderProgress(scope: XydcOrderReadScope, families: readonly XydcVariantFamily[]) {
  if (!scope.currentRunId || !process.env.AGENT_DATABASE_URL) return null;
  const pool = createXydcProgressPool(process.env);
  try {
    const roots = resolveRuntimeRoots({ codeRoot: getProjectRoot(), formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), env: process.env, commit: undefined });
    return await readXydcOrderProgress(roots.runtimeRoot, scope, families, createXydcJobAuthority(pool));
  } catch { return null; }
  finally { await pool.end(); }
}

function parseRuntimeQuery(url: URL) {
  return {
    projectId: url.searchParams.get("projectId"),
    asins: (url.searchParams.get("asins") ?? "")
      .split(",")
      .map(value => value.trim().toUpperCase())
      .filter(Boolean),
  };
}

function forwardSessionHeaders(request: Request) {
  const headers = new Headers({ origin: new URL(request.url).origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function sameAsinSet(left: readonly string[], right: readonly string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((asin, index) => asin === sortedRight[index]);
}

export function createRuntimeAnalysisDataHandler(dependencies: RuntimeAnalysisDataDependencies) {
  return async function GET(request: Request) {
    const parsed = RuntimeAnalysisDataQuerySchema.safeParse(parseRuntimeQuery(new URL(request.url)));
    if (!parsed.success) return Response.json({ error: "运行时数据请求无效" }, { status: 400 });

    const projectResult = await dependencies.client({
      method: "GET",
      path: `/v1/projects/${parsed.data.projectId}`,
      headers: forwardSessionHeaders(request),
    });
    if (projectResult.status !== 200) {
      return Response.json(projectResult.body, { status: projectResult.status });
    }

    const project = GetProjectResponseSchema.safeParse(projectResult.body);
    if (!project.success) return Response.json({ error: "项目数据暂不可用" }, { status: 502 });
    if (project.data.project.id !== parsed.data.projectId || !sameAsinSet(project.data.project.asins, parsed.data.asins)) {
      return Response.json({ error: "当前项目与 ASIN 范围不匹配" }, { status: 409 });
    }

    const strict = new URL(request.url).searchParams.get("exportStrict") === "1";
    if (strict && !dependencies.readStrictSnapshot) return Response.json({ error: "严格缓存读取不可用" }, { status: 501 });
    let snapshot: RuntimeAnalysisDataSnapshot;
    try {
      snapshot = RuntimeAnalysisDataSnapshotSchema.parse(
        strict ? dependencies.readStrictSnapshot!(parsed.data.asins, project.data.project.marketplace)
          : dependencies.readSnapshot(parsed.data.asins, project.data.project.marketplace),
      );
    } catch {
      if (strict) return Response.json({ error: "变体或订单缓存读取失败，请刷新后重试导出" }, { status: 502 });
      throw new Error("运行时分析数据暂不可用");
    }
    const authorized = project.data.project;
    snapshot.xydcOrderProgress = await dependencies.readProgress?.({
      organizationId: authorized.organizationId, projectId: authorized.id, currentRunId: authorized.currentRunId,
      country: authorized.marketplace, asins: authorized.asins,
    }, snapshot.variants.families) ?? null;
    if (strict) snapshot.exportScope = {
      projectId: authorized.id, organizationId: authorized.organizationId,
      marketplace: authorized.marketplace, asins: [...authorized.asins],
      readAt: new Date().toISOString(),
      contentHash: createHash("sha256").update(JSON.stringify({ variants: snapshot.variants, variantOrders: snapshot.variantOrders })).digest("hex"),
    };
    return Response.json(RuntimeAnalysisDataSnapshotSchema.parse(snapshot));
  };
}

function missingFile(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

function readStrictXydcTranslatedAttribute(root: string, attribute: XydcVariantFamily["children"][number]["attributes"][number]) {
  const id = createHash("sha256").update(JSON.stringify(
    [attribute.dimension, attribute.value].map(value => value.trim().replace(/\s+/g, " ").toLowerCase()),
  )).digest("hex");
  let raw: string;
  try { raw = fs.readFileSync(path.join(root, "xydc-labels", "v1", `${id}.json`), "utf8"); }
  catch (error) { if (missingFile(error)) return attribute; throw error; }
  const entry: unknown = JSON.parse(raw);
  const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  const label = record.labelZh;
  const validLabel = typeof label === "string" && label.length <= 120 && /[\u3400-\u9fff]/.test(label)
    && !/[<>\r\n\x00-\x1f]/.test(label)
    && JSON.stringify(attribute.value.match(/\d+(?:\.\d+)?/g) ?? []) === JSON.stringify(label.match(/\d+(?:\.\d+)?/g) ?? []);
  if (record.id !== id || typeof record.retryAfter !== "number" || !Number.isFinite(record.retryAfter) || (label !== null && !validLabel)) {
    throw new Error("变体译名缓存格式无效");
  }
  return validLabel ? { ...attribute, labelZh: label } : attribute;
}

function readScopedXydcVariantFamilies(asins: readonly string[], country: string, strict = false): XydcVariantFamily[] {
  const dataRoot = process.env.AGENT_DATA_ROOT;
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    if (strict) throw new Error("变体与订单缓存目录未配置或不是绝对路径");
    return [];
  }
  const expectedCountry = country.trim().toUpperCase();

  return asins.flatMap(inputAsin => {
    try {
      const expectedInputAsin = inputAsin.trim().toUpperCase();
      const cached = JSON.parse(fs.readFileSync(xydcVariantCachePath(dataRoot, country, inputAsin), "utf8"));
      const parsed = XydcVariantFamilySchema.safeParse(cached);
      if (strict && (!parsed.success || parsed.data.inputAsin !== expectedInputAsin || parsed.data.country !== expectedCountry)) {
        throw new Error("变体缓存格式或授权范围不匹配");
      }
      return parsed.success && parsed.data.inputAsin === expectedInputAsin && parsed.data.country === expectedCountry ? [{
        ...parsed.data,
        children: parsed.data.children.map(child => ({ ...child,
          attributes: child.attributes.map(attribute => strict
            ? readStrictXydcTranslatedAttribute(dataRoot, attribute)
            : readXydcTranslatedAttribute(dataRoot, attribute)),
        })),
      }] : [];
    } catch (error) {
      if (strict && !missingFile(error)) throw error;
      return [];
    }
  });
}

function readScopedXydcOrderFamilies(
  families: readonly XydcVariantFamily[],
  window: XydcOrderWindow,
  now: Date,
  strict = false,
): XydcOrderSnapshot[] {
  const dataRoot = process.env.AGENT_DATA_ROOT;
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    if (strict) throw new Error("变体与订单缓存目录未配置或不是绝对路径");
    return [];
  }
  const seen = new Set<string>();
  return families.flatMap(family => {
    try {
      const snapshot = strict ? readStrictXydcOrderDisplaySnapshot(dataRoot, family, window, now)
        : readXydcOrderDisplaySnapshot(dataRoot, family, window, now);
      if (!snapshot) return [];
      const identity = `${snapshot.country}:${snapshot.parentAsin}:${[...snapshot.childAsins].sort().join(",")}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [snapshot];
    } catch (error) {
      if (strict) throw error;
      return [];
    }
  });
}

function readStrictXydcOrderDisplaySnapshot(dataRoot: string, family: XydcVariantFamily, window: XydcOrderWindow, now: Date) {
  if (!family.children.length) return null;
  const currentPath = xydcOrderCachePath(dataRoot, family, window);
  const directory = path.dirname(currentPath);
  const pattern = new RegExp(`^${family.parentAsin}-\\d{4}-(?:0[1-9]|1[0-2])-\\d{4}-(?:0[1-9]|1[0-2])-[0-9a-f]{20}\\.json$`);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (!missingFile(error)) throw error; }
  const paths = new Set([currentPath, ...entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name)).map(entry => path.join(directory, entry.name))]);
  const candidates: XydcOrderSnapshot[] = [];
  for (const filePath of paths) {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(filePath); }
    catch (error) { if (missingFile(error)) continue; throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    let parsed: XydcOrderSnapshot;
    try { parsed = XydcOrderSnapshotSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
    catch (error) { if (missingFile(error)) continue; throw error; }
    if (path.resolve(filePath) === path.resolve(xydcOrderCachePath(dataRoot, family, parsed.window))) candidates.push(parsed);
  }
  return selectXydcOrderDisplaySnapshot(candidates, family, window, now);
}

function groupXydcOrderLookupFamilies(families: readonly XydcVariantFamily[]): XydcVariantFamily[] {
  const groups = new Map<string, {
    family: XydcVariantFamily;
    children: XydcVariantFamily["children"][number][];
    seen: Set<string>;
  }>();
  for (const family of families) {
    const key = `${family.country}:${family.parentAsin}`;
    let group = groups.get(key);
    if (!group) {
      group = { family, children: [], seen: new Set<string>() };
      groups.set(key, group);
    }
    for (const child of family.children) {
      if (!group.seen.has(child.asin)) {
        group.seen.add(child.asin);
        group.children.push(child);
      }
    }
  }
  return [...groups.values()].map(group => ({ ...group.family, children: group.children }));
}

export function readGeneratedRuntimeAnalysisData(
  asins: readonly string[],
  country: string,
  overrides: {
    readVariantFamilies?: (requestedAsins: readonly string[], cacheCountry: string) => XydcVariantFamily[];
    readOrderFamilies?: (
      families: readonly XydcVariantFamily[],
      window: XydcOrderWindow,
      now: Date,
    ) => XydcOrderSnapshot[];
    now?: Date;
    strictCacheRead?: boolean;
  } = {},
): RuntimeAnalysisDataSnapshot {
  const readVariantFamilies = overrides.readVariantFamilies ?? ((requested: readonly string[], cacheCountry: string) =>
    readScopedXydcVariantFamilies(requested, cacheCountry, overrides.strictCacheRead));
  const now = overrides.now ?? new Date();
  const orderWindow = getXydcOrderWindow(now);
  const variantFamilies = readVariantFamilies(asins, country);
  const readOrderFamilies = overrides.readOrderFamilies ?? ((families: readonly XydcVariantFamily[], requestedWindow: XydcOrderWindow, observedAt: Date) =>
    readScopedXydcOrderFamilies(families, requestedWindow, observedAt, overrides.strictCacheRead));
  const requestedCatalog = readCachedArrayExport(catalogPath, "refreshedCatalog");
  const requestedSet = new Set(asins);
  const catalog = requestedCatalog.filter((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const asin = (item as { asin?: unknown }).asin;
    return typeof asin === "string" && requestedSet.has(asin);
  });
  const stageData = (stage: "keywords" | "reviews" | "sales_trend" | "fba" | "listing" | "category" | "child_sales" | "price_strategy" | "image_remarks") => {
    const projection = projectStageOutput(stage, asins, { stageStatus: "done" });
    if (!("data" in projection)) throw new Error(`Generated ${stage} data is unavailable`);
    return projection.data;
  };

  return RuntimeAnalysisDataSnapshotSchema.parse({
    catalog,
    keywords: stageData("keywords"),
    reviews: stageData("reviews"),
    salesTrend: stageData("sales_trend"),
    fba: stageData("fba"),
    listing: stageData("listing"),
    category: stageData("category"),
    childSales: stageData("child_sales"),
    priceStrategy: stageData("price_strategy"),
    imageRemarks: stageData("image_remarks"),
    variants: { families: variantFamilies },
    variantOrders: { families: readOrderFamilies(groupXydcOrderLookupFamilies(variantFamilies), orderWindow, now) },
  });
}
