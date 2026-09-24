import { RuntimeAnalysisDataSnapshotSchema, type RuntimeAnalysisDataSnapshot } from "../lib/runtime-analysis-data";
import type { ExportSection } from "./export-contracts";
import type { ExportModuleContext, ExportModuleRead } from "./export-module-context";
import { buildVariantsOrdersExportSection } from "./variants-orders-export-section";

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validatedSnapshot(value: unknown, context: ExportModuleContext): RuntimeAnalysisDataSnapshot {
  const snapshot = RuntimeAnalysisDataSnapshotSchema.parse(value);
  const scope = snapshot.exportScope;
  if (!scope || scope.projectId !== context.projectId || scope.organizationId !== context.organizationId
    || scope.marketplace !== context.marketplace || !sameSet(scope.asins, context.sourceAsins)) {
    throw new Error("变体导出来源范围无法核验");
  }
  if (Date.parse(scope.readAt) > Date.parse(context.capturedAt) + 60_000) throw new Error("变体导出读取时间异常");
  return snapshot;
}

/** A second strict read catches mutable cache and translated-label changes during preparation. */
export async function readVariantsExportSection(context: ExportModuleContext, read: ExportModuleRead): Promise<ExportSection> {
  if (!context.asins.length || context.asins.some(asin => !context.sourceAsins.includes(asin))) throw new Error("变体导出 ASIN 范围无效");
  const query = new URLSearchParams({ projectId: context.projectId, asins: context.sourceAsins.join(","), exportStrict: "1" });
  const url = `/api/runtime-analysis-data?${query}`;
  async function load() {
    const response = await read(url, { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error(`变体与订单缓存读取失败（${response.status}）`);
    return validatedSnapshot(await response.json(), context);
  }
  const first = await load();
  const second = await load();
  if (first.exportScope?.contentHash !== second.exportScope?.contentHash
    || JSON.stringify({ variants: first.variants, orders: first.variantOrders })
      !== JSON.stringify({ variants: second.variants, orders: second.variantOrders })) {
    throw new Error("变体或订单缓存正在变化，请重试导出");
  }
  return buildVariantsOrdersExportSection({ snapshot: first, selectedAsins: context.asins,
    sourceAsins: context.sourceAsins, marketplace: context.marketplace, capturedAt: context.capturedAt, version: context.version });
}
