import type { ProductLaunchAnalysis, LaunchProductInput } from "../app/product-launch-analysis";
import type { FinalProductDefinitionReport } from "../app/final-product-definition";
import type { AnalysisInputScope } from "./product-structure-rules";

export type LocalRuleReport = {
  schemaVersion: "local-rule-report/v1";
  id: string;
  createdAt: string;
  inputScope: AnalysisInputScope;
  ruleSetVersion: string;
  inputSourceNote: string;
  products: LaunchProductInput[];
  analysis: ProductLaunchAnalysis;
  finalDefinition: FinalProductDefinitionReport;
  sourceBindings?: {
    manualVoc: Array<{ asin: string; revision: string; contentHash: string }>;
    stages: Array<{ stage: "keywords" | "reviews"; runId: string; jobId: string; status: "done"; contentHash: string; outputVersion: number }>;
  };
  sourceAvailability?: { state: "available" | "historical" | "unavailable"; message: string };
};
