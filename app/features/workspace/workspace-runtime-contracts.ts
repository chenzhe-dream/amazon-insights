import { type RuntimeAnalysisDataSnapshot } from "../../lib/runtime-analysis-data";

export function currentWebArtifactId(): string {
  return document.documentElement.dataset.webArtifactId ?? "legacy";
}

export const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";

export const RUNTIME_ANALYSIS_REFRESH_FAILED = "最新分析数据暂未刷新，页面已保留现有结果";

export type RuntimeAnalysisRefreshResult =
  | Readonly<{ ok: true; snapshot: RuntimeAnalysisDataSnapshot }>
  | Readonly<{ ok: false; reason: "failed" | "superseded"; message: string }>;
