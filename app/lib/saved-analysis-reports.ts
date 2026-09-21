import {
  AnalysisReportSchema,
  GetReportResponseSchema,
  ReportIdParamsSchema,
  RunIdParamsSchema,
  type AnalysisReport,
  type StageName,
} from "../../shared/agent-contracts";
import { localAgentErrorMessage, localAgentFetch } from "./local-agent-browser";

type BrowserFetch = (input: string, init?: RequestInit) => Promise<Response>;

export const ANALYSIS_REPORT_STAGES = [
  "traffic-analysis",
  "voc-positioning",
  "product-definition",
] as const satisfies readonly StageName[];

export type SavedAnalysisReportSelection = Partial<Record<StageName, string>>;

export type SavedAnalysisReportSlot = Readonly<{
  stage: typeof ANALYSIS_REPORT_STAGES[number];
  history: readonly AnalysisReport[];
  selected: AnalysisReport | null;
}>;

export type SavedAnalysisReportView = Readonly<{
  schemaVersion: "1.0.0";
  runId: string;
  stages: readonly SavedAnalysisReportSlot[];
}>;

function orderedReports(reports: readonly AnalysisReport[]) {
  return [...reports].sort((left, right) =>
    right.version - left.version ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.id.localeCompare(right.id),
  );
}

export function buildSavedAnalysisReportView(
  runId: string,
  reports: readonly unknown[],
  selectedIds: SavedAnalysisReportSelection = {},
): SavedAnalysisReportView {
  RunIdParamsSchema.parse({ runId });
  const parsed = reports.map((report) => AnalysisReportSchema.parse(report));
  if (parsed.some((report) => report.runId !== runId)) {
    throw new TypeError("Saved report does not belong to the selected run");
  }

  return Object.freeze({
    schemaVersion: "1.0.0" as const,
    runId,
    stages: Object.freeze(ANALYSIS_REPORT_STAGES.map((stage) => {
      const history = Object.freeze(orderedReports(parsed.filter((report) => report.stage === stage)));
      const explicitlySelected = selectedIds[stage]
        ? history.find((report) => report.id === selectedIds[stage]) ?? null
        : null;
      return Object.freeze({
        stage,
        history,
        selected: explicitlySelected ?? history.find((report) => report.status === "complete") ?? null,
      });
    })),
  });
}

export function serializeSavedAnalysisReportView(view: SavedAnalysisReportView) {
  return JSON.stringify({
    schemaVersion: view.schemaVersion,
    runId: view.runId,
    reports: Object.fromEntries(view.stages.map(({ stage, selected }) => [
      stage,
      selected
        ? {
            schemaVersion: selected.schemaVersion,
            id: selected.id,
            stage: selected.stage,
            version: selected.version,
            status: selected.status,
            skill: selected.skill,
            dataCutoffAt: selected.dataCutoffAt,
            result: selected.result,
          }
        : null,
    ])),
  }, null, 2);
}

export async function readSavedAnalysisReport(
  reportId: string,
  fetchImpl: BrowserFetch = localAgentFetch,
) {
  ReportIdParamsSchema.parse({ reportId });
  const response = await fetchImpl(`/v1/reports/${encodeURIComponent(reportId)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(localAgentErrorMessage(payload, "Unable to read saved analysis report"));
  }
  return GetReportResponseSchema.parse(payload).report;
}
