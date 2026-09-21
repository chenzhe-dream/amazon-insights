import type { AgentServiceClient } from "./agent-service-client";
import { LocalDataStageOutputResponseSchema, ManualAlexaVocListResponseSchema } from "../../shared/agent-contracts";
import type { LocalRuleReport } from "../../shared/local-rule-report";
import type { AnalysisRuleTrace, EvidenceSource } from "../../shared/product-structure-rules";

/** Refresh availability only; never replace saved decisions or definitions. */
export async function reconcileLocalRuleReportSources(report: LocalRuleReport, client: AgentServiceClient, headers: Headers): Promise<LocalRuleReport> {
  const copy = structuredClone(report);
  const bindings = report.sourceBindings;
  const unavailableManual = new Set<string>();
  let unavailableKeywords = false, unavailableReviews = false, unavailable = false, changed = false;
  if (!bindings) {
    unavailable = true; unavailableKeywords = true; unavailableReviews = true;
    report.inputScope.asins.forEach(asin => unavailableManual.add(asin));
  } else {
    if (bindings.manualVoc.length) {
      try {
        const query = new URLSearchParams({ projectId: report.inputScope.projectId, marketplace: report.inputScope.marketplace });
        bindings.manualVoc.forEach(binding => query.append("asins", binding.asin));
        const response = await client({ method: "GET", path: `/v1/manual-alexa-voc?${query}`, headers });
        const parsed = ManualAlexaVocListResponseSchema.safeParse(response.body);
        for (const binding of bindings.manualVoc) {
          const current = response.status === 200 && parsed.success ? parsed.data.records.find(record => record.asin === binding.asin && record.marketplace === report.inputScope.marketplace) : undefined;
          if (!current) { unavailable = true; unavailableManual.add(binding.asin); }
          else if (current.revision !== binding.revision || current.contentHash !== binding.contentHash) { changed = true; unavailableManual.add(binding.asin); }
        }
      } catch { unavailable = true; bindings.manualVoc.forEach(binding => unavailableManual.add(binding.asin)); }
    }
    for (const binding of bindings.stages) {
      let valid = false;
      try {
        const response = await client({ method: "GET", path: `/v1/projects/${report.inputScope.projectId}/runs/${binding.runId}/sync-jobs/${encodeURIComponent(binding.jobId)}/stages/${binding.stage}/output`, headers });
        const parsed = LocalDataStageOutputResponseSchema.safeParse(response.body);
        if (response.status === 200 && parsed.success && parsed.data.projectId === report.inputScope.projectId && parsed.data.runId === binding.runId && parsed.data.jobId === binding.jobId && parsed.data.stage === binding.stage && parsed.data.stageStatus === "done") {
          valid = parsed.data.contentHash === binding.contentHash && parsed.data.outputVersion === binding.outputVersion;
          if (!valid) changed = true;
        } else unavailable = true;
      } catch { unavailable = true; }
      if (!valid) { if (binding.stage === "keywords") unavailableKeywords = true; else unavailableReviews = true; }
    }
  }
  const visible = (source: EvidenceSource) => {
    if (source.kind === "keyword") return !unavailableKeywords;
    if (source.kind !== "voc") return true;
    if (source.id.includes(":review:")) return !unavailableReviews;
    return Boolean(source.asin && !unavailableManual.has(source.asin));
  };
  function redact(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(redact); return; }
    for (const [key, nested] of Object.entries(value)) {
      if (key === "ruleTrace" && nested && typeof nested === "object") {
        const trace = nested as AnalysisRuleTrace;
        trace.sources = trace.sources.filter(visible);
        trace.contexts?.forEach(context => { context.evidence = context.evidence.filter(visible); context.needs = context.needs.filter(visible); });
      } else redact(nested);
    }
  }
  redact(copy.analysis); redact(copy.finalDefinition);
  copy.sourceAvailability = unavailable ? { state: "unavailable", message: "部分生成来源已失效或当前无权读取；相关原文已隐藏，以下保留生成时结果与规则版本。" }
    : changed ? { state: "historical", message: "生成来源已有新版本；旧来源原文已隐藏，以下保留生成时结果与规则版本。" }
      : { state: "available", message: "生成时来源仍可读取，规则解释使用保存时快照。" };
  return copy;
}
