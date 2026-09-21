import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LocalRuleReport } from "../../shared/local-rule-report";
import type { AnalysisInputScope, AnalysisRuleTrace } from "../../shared/product-structure-rules";

function segment(value: string) { return createHash("sha256").update(value).digest("hex"); }
function scopeKey(scope: AnalysisInputScope) { return JSON.stringify([scope.organizationId, scope.projectId, scope.marketplace, [...scope.asins].sort(), scope.inputRevision]); }
/** Validate snapshots without comparing them with today's rule definitions. */
export function assertLocalRuleReportIntegrity(report: LocalRuleReport) {
  const key = scopeKey(report.inputScope);
  for (const trace of [report.analysis.ruleTrace, report.finalDefinition.ruleTrace].filter((value): value is AnalysisRuleTrace => Boolean(value))) {
    if (scopeKey(trace.inputScope) !== key || trace.ruleSetVersion !== report.ruleSetVersion) throw new Error("Saved rule trace scope is invalid");
    const definitions = new Map(trace.ruleDefinitions.map(rule => [rule.id, rule.version]));
    for (const decision of trace.decisions) {
      if (scopeKey(decision.inputScope) !== key || !report.inputScope.asins.includes(decision.asin) || decision.ruleSetVersion !== report.ruleSetVersion || decision.ruleIds.some(id => definitions.get(id) !== decision.ruleVersions[id])) throw new Error("Saved decision scope or rule snapshot is invalid");
    }
    for (const source of trace.sources) {
      if ((source.inputScope && scopeKey(source.inputScope) !== key) || (source.asin && !report.inputScope.asins.includes(source.asin))) throw new Error("Saved source scope is invalid");
      // Missing referenced sources remain missing; readers show source-unavailable.
    }
    for (const context of trace.contexts ?? []) {
      if (scopeKey(context.inputScope) !== key || !report.inputScope.asins.includes(context.asin)) throw new Error("Saved source context scope is invalid");
      for (const source of [...context.evidence, ...context.needs]) {
        if ((source.inputScope && scopeKey(source.inputScope) !== key) || (source.asin && !report.inputScope.asins.includes(source.asin))) throw new Error("Saved source context scope is invalid");
      }
    }
  }
}
export function createLocalRuleReportStore(dataRoot: string) {
  const directory = (organizationId: string, projectId: string) => join(dataRoot, "local-rule-reports", segment(organizationId), segment(projectId));
  return {
    async save(report: LocalRuleReport) {
      assertLocalRuleReportIntegrity(report);
      const dir = directory(report.inputScope.organizationId, report.inputScope.projectId);
      await mkdir(dir, { recursive: true });
      // Content identity includes full scope, input revision and generating rule version.
      const target = join(dir, `${segment(report.id)}.json`);
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(report), { flag: "wx", mode: 0o600 });
        // The UUID is allocated by the server. Reports are never updated.
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      return report;
    },
    async list(organizationId: string, projectId: string, asins: readonly string[]) {
      const dir = directory(organizationId, projectId);
      let files: string[];
      try { files = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      const reports: LocalRuleReport[] = [];
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
        const report = JSON.parse(await readFile(join(dir, file), "utf8")) as LocalRuleReport;
        if (report.schemaVersion !== "local-rule-report/v1" || report.inputScope.organizationId !== organizationId || report.inputScope.projectId !== projectId) throw new Error("Saved rule report scope is invalid");
        assertLocalRuleReportIntegrity(report);
        if ([...report.inputScope.asins].sort().join(",") === [...asins].sort().join(",")) reports.push(report);
      }
      return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
