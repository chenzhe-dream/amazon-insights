import { z } from "zod";

import { XydcOrderSnapshotSchema } from "../../shared/xydc-order-contract";
import { XydcVariantFamilySchema } from "../../shared/xydc-variant-contract";
import { XydcOrderProgressViewSchema } from "../../shared/xydc-order-progress";

const map = z.record(z.string(), z.unknown());

export const RuntimeAnalysisDataSnapshotSchema = z.strictObject({
  catalog: z.array(z.unknown()),
  keywords: z.strictObject({ analysisByAsin: map, enrichmentByKeyword: map }),
  reviews: z.strictObject({ analysisByAsin: map, ratingByAsin: map }),
  salesTrend: z.strictObject({ trendByAsin: map }),
  fba: z.strictObject({ feeByAsin: map }),
  listing: z.strictObject({ contentByAsin: map }),
  category: z.strictObject({ trendByNode: map }),
  childSales: z.strictObject({ rowsByAsin: map }),
  priceStrategy: z.strictObject({ strategyByAsin: map }),
  imageRemarks: z.strictObject({ remarksByAsin: map, outcomesByAsin: map }),
  variants: z.strictObject({ families: z.array(XydcVariantFamilySchema) }).default({ families: [] }),
  variantOrders: z.strictObject({ families: z.array(XydcOrderSnapshotSchema) }).default({ families: [] }),
  xydcOrderProgress: XydcOrderProgressViewSchema.nullable().default(null),
});

export type RuntimeAnalysisDataSnapshot = z.infer<typeof RuntimeAnalysisDataSnapshotSchema>;
export type RuntimeAnalysisDataSnapshotInput = z.input<typeof RuntimeAnalysisDataSnapshotSchema>;

/** Tokens cannot become current again after leaving and returning to an equivalent scope. */
export function createRuntimeAnalysisScopeGuard() {
  let token: Readonly<{ key: string }> | null = null;
  return {
    activate(key: string | null) { token = key === null ? null : Object.freeze({ key }); },
    capture() { return token; },
    isCurrent(captured: Readonly<{ key: string }> | null) { return captured !== null && token === captured; },
  };
}

export async function readRuntimeAnalysisData(
  projectId: string,
  asins: readonly string[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RuntimeAnalysisDataSnapshot> {
  const query = new URLSearchParams({ projectId, asins: asins.join(",") });
  const response = await fetchImpl(`/api/runtime-analysis-data?${query}`, { signal });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error("最新分析数据暂未刷新，页面已保留现有结果");
  return RuntimeAnalysisDataSnapshotSchema.parse(payload);
}

export async function readAndCommitRuntimeAnalysisData(projectId: string, asins: readonly string[], options: {
  signal?: AbortSignal; isCurrent: () => boolean; commit: (snapshot: RuntimeAnalysisDataSnapshot) => void; fetchImpl?: typeof fetch;
}) {
  const snapshot = await readRuntimeAnalysisData(projectId, asins, options.fetchImpl, options.signal);
  if (options.signal?.aborted || !options.isCurrent()) return null;
  options.commit(snapshot);
  return snapshot;
}
