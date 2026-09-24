import { RULE_DEFINITIONS, RULE_SET_VERSION, describeRulePredicate, type AnalysisRuleTrace, type RuleDefinition } from "../../shared/product-structure-rules";
import type { ExportBlock } from "./export-contracts";

const cell = (value: unknown) => ({ text: value === null || value === undefined || value === "" ? "—" : String(value) });
const definitions = (title: string, rules: readonly RuleDefinition[]): ExportBlock => ({
  kind: "table", title, columns: ["规则", "流程节点", "目的", "适用条件", "排除条件", "资料缺失", "来源冲突", "正例", "反例"],
  rows: rules.map(rule => [`${rule.id} · ${rule.name} · v${rule.version}`, rule.flowNode, rule.purpose,
    rule.conditions.map(describeRulePredicate).join("；"), rule.exclusions.join("；"), rule.missingPolicy,
    rule.conflictPolicy, rule.positiveExample, rule.negativeExample].map(cell)),
});
/** Includes the explanation normally hidden behind the page's rule disclosure controls. */
export function buildExportRuleTrace(trace?: AnalysisRuleTrace): ExportBlock[] {
  const blocks: ExportBlock[] = [{
    kind: "text", text: `分析规则说明 · 当前规则版本 ${RULE_SET_VERSION}。${trace ? "以下保留本结果的判断与依据。" : "此结果未记录规则判定明细。"}`,
  }, definitions("当前规则定义（供对照）", RULE_DEFINITIONS)];
  if (!trace) return blocks;
  blocks.push({ kind: "text", text: `本结果保存的规则版本：${trace.ruleSetVersion}。下表保留生成时的定义，未用当前定义替换。` },
    definitions("本结果保存的规则定义", trace.ruleDefinitions));
  const sources = new Map(trace.sources.map(source => [source.id, source]));
  blocks.push({kind:"table",title:"逐项判定与原始依据",columns:["判定引用","ASIN","内容","性质","结论","说明","判定规则集版本","规则及版本","条件核对","原始依据","待核对"],
    rows:trace.decisions.map(decision => [decision.candidateId,decision.asin,decision.text,decision.kind==="fact"?"现有事实":"开发建议",
      decision.outcome==="supported"?"已采用":decision.outcome==="rejected"?"未采用":"待核对",decision.summary,
      decision.ruleSetVersion,decision.ruleIds.map(id=>`${id} v${decision.ruleVersions[id]??"—"}`).join("；"),
      decision.matchedConditions.map(item=>`${item.passed===true?"满足":item.passed===false?"不满足":"未知"}：${item.description}`).join("\n"),
      decision.evidenceRefs.map(id=>{const source=sources.get(id);return source?`${id} · ${source.asin??"项目级"} · ${source.kind}：${source.text}`:`来源不可用（${id}）`;}).join("\n"),
      decision.checks.join("\n")].map(cell))});
  return blocks;
}
