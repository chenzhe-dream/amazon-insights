import "server-only";

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { AsinSchema, EntityIdSchema, GetProjectResponseSchema } from "../../shared/agent-contracts";
import { getProjectRoot } from "../../scripts/lib/project-root.mjs";
import { readCachedArrayExport } from "../../scripts/lib/sync-cache.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import { xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import { XydcVariantFamilySchema, type XydcVariantFamily } from "../../shared/xydc-variant-contract";
import type { AgentServiceClient } from "./agent-service-client";
import {
  RuntimeAnalysisDataSnapshotSchema,
  type RuntimeAnalysisDataSnapshot,
} from "./runtime-analysis-data";

type RuntimeAnalysisDataDependencies = Readonly<{
  client: AgentServiceClient;
  readSnapshot: (asins: readonly string[], country: string) => RuntimeAnalysisDataSnapshot;
}>;

const RuntimeAnalysisDataQuerySchema = z.strictObject({
  projectId: EntityIdSchema,
  asins: z.array(AsinSchema).min(3).max(10).refine(values => new Set(values).size === values.length),
});

const catalogPath = path.join(getProjectRoot(), "app", "competitor-data.ts");

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
    if (!sameAsinSet(project.data.project.asins, parsed.data.asins)) {
      return Response.json({ error: "当前项目与 ASIN 范围不匹配" }, { status: 409 });
    }

    return Response.json(dependencies.readSnapshot(parsed.data.asins, project.data.project.marketplace));
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

export function readGeneratedRuntimeAnalysisData(
  asins: readonly string[],
  country: string,
  overrides: {
    readVariantFamilies?: (requestedAsins: readonly string[], cacheCountry: string) => XydcVariantFamily[];
  } = {},
): RuntimeAnalysisDataSnapshot {
  const readVariantFamilies = overrides.readVariantFamilies ?? readScopedXydcVariantFamilies;
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
    variants: { families: readVariantFamilies(asins, country) },
  });
}
