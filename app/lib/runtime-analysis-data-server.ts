import "server-only";

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { AsinSchema, EntityIdSchema, GetProjectResponseSchema } from "../../shared/agent-contracts";
import { getProjectRoot } from "../../scripts/lib/project-root.mjs";
import { readCachedArrayExport } from "../../scripts/lib/sync-cache.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import { isCurrentXydcOrderTimestamp, xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import { XydcOrderSnapshotSchema, type XydcOrderSnapshot, type XydcOrderWindow } from "../../shared/xydc-order-contract";
import { getXydcOrderWindow, matchesXydcOrderSnapshot } from "../../shared/xydc-order-summary";
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
  readProgress?: (scope: XydcOrderReadScope, families: readonly XydcVariantFamily[]) => Promise<XydcOrderProgressView | null>;
}>;

const RuntimeAnalysisDataQuerySchema = z.strictObject({
  projectId: EntityIdSchema,
  asins: z.array(AsinSchema).min(3).max(10).refine(values => new Set(values).size === values.length),
});

const catalogPath = path.join(getProjectRoot(), "app", "competitor-data.ts");

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

    const snapshot = RuntimeAnalysisDataSnapshotSchema.parse(
      dependencies.readSnapshot(parsed.data.asins, project.data.project.marketplace),
    );
    const authorized = project.data.project;
    snapshot.xydcOrderProgress = await dependencies.readProgress?.({
      organizationId: authorized.organizationId, projectId: authorized.id, currentRunId: authorized.currentRunId,
      country: authorized.marketplace, asins: authorized.asins,
    }, snapshot.variants.families) ?? null;
    return Response.json(RuntimeAnalysisDataSnapshotSchema.parse(snapshot));
  };
}

function readScopedXydcVariantFamilies(asins: readonly string[], country: string): XydcVariantFamily[] {
  const dataRoot = process.env.AGENT_DATA_ROOT;
  if (!dataRoot || !path.isAbsolute(dataRoot)) return [];
  const expectedCountry = country.trim().toUpperCase();

  return asins.flatMap(inputAsin => {
    try {
      const expectedInputAsin = inputAsin.trim().toUpperCase();
      const cached = JSON.parse(fs.readFileSync(xydcVariantCachePath(dataRoot, country, inputAsin), "utf8"));
      const parsed = XydcVariantFamilySchema.safeParse(cached);
      return parsed.success && parsed.data.inputAsin === expectedInputAsin && parsed.data.country === expectedCountry ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

function readScopedXydcOrderFamilies(
  families: readonly XydcVariantFamily[],
  window: XydcOrderWindow,
  now: Date,
): XydcOrderSnapshot[] {
  const dataRoot = process.env.AGENT_DATA_ROOT;
  if (!dataRoot || !path.isAbsolute(dataRoot)) return [];
  const seen = new Set<string>();
  return families.flatMap(family => {
    try {
      const raw = JSON.parse(fs.readFileSync(xydcOrderCachePath(dataRoot, family, window), "utf8"));
      const parsed = XydcOrderSnapshotSchema.safeParse(raw);
      if (!parsed.success || !matchesXydcOrderSnapshot(parsed.data, family, window)) return [];
      if (!isCurrentXydcOrderTimestamp(parsed.data.fetchedAt, now)
        || parsed.data.children.some(child => !isCurrentXydcOrderTimestamp(child.fetchedAt, now))) return [];
      const identity = `${parsed.data.country}:${parsed.data.parentAsin}:${[...parsed.data.childAsins].sort().join(",")}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [parsed.data];
    } catch {
      return [];
    }
  });
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
  } = {},
): RuntimeAnalysisDataSnapshot {
  const readVariantFamilies = overrides.readVariantFamilies ?? readScopedXydcVariantFamilies;
  const now = overrides.now ?? new Date();
  const orderWindow = getXydcOrderWindow(now);
  const variantFamilies = readVariantFamilies(asins, country);
  const readOrderFamilies = overrides.readOrderFamilies ?? readScopedXydcOrderFamilies;
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
