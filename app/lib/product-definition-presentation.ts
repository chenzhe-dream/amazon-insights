import type { FinalDefinitionRow } from '../final-product-definition';
import type { AnalysisInputScope, AnalysisRuleTrace } from '../../shared/product-structure-rules';
import { parseApplicabilityObservation } from '../../shared/voc-applicability';

// Display-only guard: uncertain or qualified text stays visible, never becomes a short positive label.
export function hasVisibleQualification(text: string): boolean {
  const observation = parseApplicabilityObservation({id:'display-only',asin:'',text});
  return (!!observation && observation.status !== 'reported') || /不适|不推荐|不建议|不得|禁止|不能|不可|不宜|不应|避免|请勿|严禁|限制|待核对|待验证|待确认|未验证|验收|未知|冲突|仅|须|需要|需[在由有具遵核确验]|条件|前提|尚未|未确认|无.{0,8}(?:依据|证据)|\b(?:not|never|only|must|should|unless|if|when|requires?|unknown|unverified|without|avoid|may|but)\b/iu.test(text);
}

export type ConclusionPresentation = {
  summarized: boolean;
  points: string[];
  warnings: string[];
  productKeys: Array<{label: string; asin: string}>;
};

/** Cards have no independent decision IDs; borrow a row only when its original value matches exactly. */
export function presentDefinitionCard(card: {key: string; value: string}, rows: FinalDefinitionRow[], trace?: AnalysisRuleTrace): ConclusionPresentation | undefined {
  const dimension = card.key === 'audience' ? '目标人群/年龄' : card.key === 'scenario' ? '核心场景' : card.key === 'product' ? '产品形态' : undefined;
  if (!dimension) return;
  const matches = rows.filter(row=>row.dimension === dimension && (card.value === row.vocBasis || card.value === row.conclusion));
  if (matches.length !== 1) return;
  const result = presentDefinitionConclusion(matches[0], trace);
  return result.summarized ? result : undefined;
}

function sameScope(left: AnalysisInputScope | undefined, right: AnalysisInputScope): boolean {
  return !!left && left.organizationId === right.organizationId && left.projectId === right.projectId &&
    left.marketplace === right.marketplace && left.inputRevision === right.inputRevision &&
    JSON.stringify([...new Set(left.asins)].sort()) === JSON.stringify([...new Set(right.asins)].sort());
}

function structuredLabel(text: string): string | undefined {
  const bracket = text.match(/^【([^】]+)】([\s\S]*)$/u);
  const parts = bracket ? [bracket[1], bracket[2]] : text.split(/[｜|]/u);
  if (parts.length < 2) return;
  const generic = /^(?:(?:最佳|主要|扩展|可接受|最优|核心|目标)(?:用户|人群|场景)?|用户|人群|场景)$/u;
  const label = (generic.test(parts[0].trim()) ? parts[1] : parts[0]).trim();
  // Do not strip qualifiers, percentages or parenthetical age ranges from a label.
  if (!label || label.length > 64 || /[；;。｜|]|代表评论|VOC记录/u.test(label) || hasVisibleQualification(label)) return;
  return label;
}

/** Rendering projection only: saved reports and their rule decisions remain untouched. */
export function presentDefinitionConclusion(row: FinalDefinitionRow, trace?: AnalysisRuleTrace): ConclusionPresentation {
  const fallback: ConclusionPresentation = {summarized:false,points:[row.conclusion],warnings:[],productKeys:[]};
  if (row.dimension === '产品形态') {
    const parts = row.conclusion.split(/(?=[【\[][A-Z0-9]{10}[】\]])/u).filter(Boolean);
    const matches = parts.map(part => part.match(/^[【\[]([A-Z0-9]{10})[】\]]\s*([\s\S]*?)\s*[；;、]?$/u));
    if (matches.length > 1 && matches.every(Boolean) && new Set(matches.map(m=>m![1])).size === matches.length) {
      const forms = [...new Set(matches.map(m=>m![2]))];
      if (forms.length === 1 && forms[0]) return {...fallback,summarized:true,points:forms};
    }
    return fallback;
  }
  const dimension = row.dimension === '目标人群/年龄' || row.dimension === '目标人群' ? 'audiences' : row.dimension === '核心场景' ? 'scenarios' : undefined;
  if (!dimension || !trace) return fallback;
  const ids = [...new Set(row.ruleDecisionIds ?? [])].filter(id=>id.startsWith(`voc-applicability:${dimension}:`));
  if (!ids.length) return fallback;
  const points: string[] = [], warnings: string[] = [];
  const productKeys: ConclusionPresentation['productKeys'] = [];
  const scopedAsins = [...new Set(trace.inputScope.asins)];
  for (const id of ids) {
    const records = trace.decisions.filter(record=>record.candidateId === id);
    if (records.length !== 1) return fallback;
    const record = records[0];
    if (record.kind !== 'fact' || record.ruleSetVersion !== trace.ruleSetVersion ||
      !sameScope(record.inputScope,trace.inputScope) || !scopedAsins.includes(record.asin) || record.evidenceRefs.length !== 1) return fallback;
    const sources = trace.sources.filter(source=>source.id === record.evidenceRefs[0]);
    if (sources.length !== 1) return fallback;
    const source = sources[0];
    if (source.kind !== 'voc' || source.scope !== 'asin' || source.asin !== record.asin || source.location !== dimension ||
      !sameScope(source.inputScope,trace.inputScope) || source.text.trim() !== record.text.trim()) return fallback;
    const observation = parseApplicabilityObservation({id:source.id,asin:record.asin,text:source.text});
    if (!observation) return fallback;
    // The applicability pipeline also copies its generic provenance explanation into checks.
    // Keep actual outstanding checks, without treating that repeated explanation as a restriction.
    const checks = record.checks.filter(check=>check !== record.summary || record.reasonCode !== 'voc_reported');
    const label = `产品 ${scopedAsins.indexOf(record.asin) + 1}`;
    const prefix = scopedAsins.length > 1 ? `${label}：` : '';
    if (!productKeys.some(key=>key.asin === record.asin)) productKeys.push({label,asin:record.asin});
    if (record.outcome !== 'supported' || record.reasonCode !== 'voc_reported' || observation.status !== 'reported' ||
      hasVisibleQualification(source.text) || record.matchedConditions.some(condition=>condition.passed !== true) || checks.length) {
      warnings.push(`${prefix}${record.outcome === 'rejected' ? '未采用' : record.reasonCode === 'voc_conflict' ? '来源冲突，待核对' : '限制与待核对'}：${source.text}`);
      warnings.push(...checks.filter(check=>check !== record.summary).map(check=>`${prefix}${check}`));
      warnings.push(...record.matchedConditions.filter(condition=>condition.passed !== true).map(condition=>`${prefix}${condition.description}`));
      continue;
    }
    const subject = structuredLabel(source.text);
    // Unstructured prose cannot safely be condensed by cutting at arbitrary punctuation.
    if (!subject) return fallback;
    points.push(`${prefix}${subject}`);
  }
  // Keep explicit missing-ASIN records from the saved conclusion visible as well.
  if (/暂无当前 ASIN 的可用记录/u.test(row.conclusion)) return fallback;
  return {summarized:true,points:[...new Set(points)],warnings:[...new Set(warnings)],productKeys};
}
