import type { LaunchProductInput } from "../product-launch-analysis";
import type { LocalRuleReport } from "../../shared/local-rule-report";
export async function saveLocalRuleReport(input: { projectId: string; asins: string[]; products: LaunchProductInput[]; baseSyncRunId?: string | null; jobId?: string | null; reviewFallback: boolean }, signal?: AbortSignal): Promise<LocalRuleReport> {
  const products = input.products.map(({ asin, brand, title, subRankCategory, rankCategory, price, sales, rating, reviews, launch, productFamily, features }) => ({ asin, brand, title, subRankCategory, rankCategory, price, sales, rating, reviews, launch, productFamily, features }));
  const response = await fetch("/api/local-rule-reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, products }), signal });
  const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "报告保存失败，请重试。"); return body.report;
}
export async function readLocalRuleReports(projectId: string, asins: string[], signal?: AbortSignal): Promise<LocalRuleReport[]> {
  const response = await fetch(`/api/local-rule-reports?${new URLSearchParams({ projectId, asins: [...asins].sort().join(",") })}`, { signal, cache: "no-store" });
  const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "历史报告读取失败，请重试。"); return body.reports;
}
