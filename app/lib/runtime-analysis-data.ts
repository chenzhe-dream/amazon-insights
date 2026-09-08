import { z } from "zod";

import { XydcOrderSnapshotSchema } from "../../shared/xydc-order-contract";
import { XydcVariantFamilySchema } from "../../shared/xydc-variant-contract";

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
});

export type RuntimeAnalysisDataSnapshot = z.infer<typeof RuntimeAnalysisDataSnapshotSchema>;
export type RuntimeAnalysisDataSnapshotInput = z.input<typeof RuntimeAnalysisDataSnapshotSchema>;

export async function readRuntimeAnalysisData(
  projectId: string,
  asins: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeAnalysisDataSnapshot> {
  const query = new URLSearchParams({ projectId, asins: asins.join(",") });
  const response = await fetchImpl(`/api/runtime-analysis-data?${query}`);
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error("最新分析数据暂未刷新，页面已保留现有结果");
  return RuntimeAnalysisDataSnapshotSchema.parse(payload);
}
