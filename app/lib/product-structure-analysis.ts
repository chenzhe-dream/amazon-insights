import {
  buildProductContext, buildAnalysisRuleTrace, decideProductCandidate, evaluateTextAction,
  groupCompatibleProducts, type AnalysisInputScope, type AnalysisRuleTrace, type DecisionRecord, type EvidenceSource, type ProductContext,
} from "../../shared/product-structure-rules";
import type { LaunchProductInput, ProductLaunchRuntimeSources } from "../product-launch-analysis";
import type { KeywordDemandAnalysis } from "../keyword-demand-analysis";
import { canonicalTheme } from "../voc-theme-merge";
import { parseApplicabilityObservation, markApplicabilityConflicts, renderApplicability, type ApplicabilityProjection } from "../../shared/voc-applicability";

export const vocRuleDimensions = ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"] as const;
type Dimension = typeof vocRuleDimensions[number];
export type RuleActionResult = { text: string; ruleDecisionIds: string[] };

/** Deterministic input revision, never a global mutable analysis cache. */
export function productInputRevision(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i=0; i<text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function createProductRuleSession(products: readonly LaunchProductInput[], sources: ProductLaunchRuntimeSources) {
  const scope: AnalysisInputScope = {
    organizationId: sources.analysisScope?.organizationId ?? "unsaved-local",
    projectId: sources.analysisScope?.projectId ?? "unsaved-local",
    marketplace: sources.analysisScope?.marketplace ?? "unknown",
    asins: products.map(p=>p.asin).sort(),
    inputRevision: sources.analysisScope?.inputRevision ?? productInputRevision({products:[...products].sort((a,b)=>a.asin.localeCompare(b.asin)), manual:products.map(p=>[p.asin,sources.manualVocByAsin[p.asin]]).sort(), reviews:products.map(p=>[p.asin,sources.reviewAnalysisByAsin?.[p.asin]]).sort(),keywords:sources.keywordDemand,revision:sources.analysisScope?.inputRevision}),
  };
  const rawByAsin = new Map<string, EvidenceSource[]>();
  const contexts = products.map(product => {
    const evidence: EvidenceSource[] = [];
    const manual = sources.manualVocByAsin[product.asin];
    if (manual?.asin === product.asin && manual.captureStatus === "dialog") {
      for (const dimension of vocRuleDimensions) for (const [index, text] of (manual[dimension] ?? []).entries()) {
        evidence.push({id:`${product.asin}:voc:${dimension}:${index}`,text,kind:"voc",scope:"asin",asin:product.asin,location:dimension,role:dimension === "positives" || dimension === "scenarios" ? "fact" : "need"});
      }
    }
    const review=sources.reviewAnalysisByAsin?.[product.asin];
    if (!evidence.length && review?.status === "ready" && (!("asin" in review) || review.asin === product.asin)) {
      for(const block of review.blocks ?? []) for(const [index,row] of block.rows.entries()) {
        evidence.push({id:`${product.asin}:review:${block.key}:${index}`,text:row.label,kind:"voc",scope:"asin",asin:product.asin,location:block.key === "consumerProfile" ? "audiences" : block.key,role:block.key === "positives" || block.key === "scenarios" ? "fact" : "need"});
      }
    }
    for (const category of sources.keywordDemand?.categories ?? []) for (const [index,kw] of category.keywords.entries()) {
      if (kw.competitors.length && !kw.competitors.some(c=>c.asin === product.asin)) continue;
      evidence.push({id:`keyword:${category.id}:${index}`,text:kw.keyword,kind:"keyword",scope:"project",location:category.id,role:"need"});
    }
    rawByAsin.set(product.asin,evidence);
    return buildProductContext({scope,asin:product.asin,title:product.title ?? "",category:product.subRankCategory || product.rankCategory,features:product.features,evidence});
  });
  const decisions: DecisionRecord[] = [];
  const save = (decision: DecisionRecord) => { decisions.push(decision); return decision; };
  const needs = (asin: string, label: string, dimension?:Dimension): EvidenceSource[] => {
    const all = (rawByAsin.get(asin) ?? []).filter(e=>e.kind === "voc" && (!dimension || e.location === dimension));
    if (!label) return all;
    return all.filter(e=>e.text.includes(label) || label.includes(e.text) || (dimension && canonicalTheme(e.text.match(/【([^】]+)】/)?.[1] ?? e.text,dimension,"generic").key === canonicalTheme(label,dimension,"generic").key));
  };

  function action(label:string, dimension:Dimension, id:string):RuleActionResult {
    const pieces:string[]=[];
    const ids:string[]=[];
    for(const context of contexts) {
      const evidence=needs(context.asin,label,dimension);
      if(!evidence.length) continue;
      // The aggregate label may normalize 灯泡易坏 to 耐用性. Generate from
      // the matched product's own issue, so a theme never invents a mechanism.
      const sourceLabels=[...new Set(evidence.map(e=>e.text.match(/【([^】]+)】/)?.[1] ?? e.text.replace(/^\s*\d+[.、．]\s*/u,"")))];
      const text=groundedAction(sourceLabels.join("；"),dimension,context);
      const record=save(evaluateTextAction(context,text,{id:`${id}:${context.asin}`,needEvidenceRefs:evidence.map(e=>e.id),kind:"proposal"}));
      ids.push(record.candidateId);
      if(record.outcome === "supported") pieces.push(`${contexts.length>1 ? `【${context.asin}】` : ""}${text}`);
      else pieces.push(`${contexts.length>1 ? `【${context.asin}】` : ""}核对「${label}」：${record.summary}`);
    }
    return {text:pieces.join("；") || `核对「${label}」对应的原始反馈与商品范围后制定验收方法`,ruleDecisionIds:ids};
  }

  function explain(text:string,id:string, refs?:string[]):RuleActionResult {
    const ids:string[]=[];
    const records:DecisionRecord[]=[];
    for(const context of contexts) {
      const sourceRefs=refs ?? (rawByAsin.get(context.asin)??[]).map(e=>e.id);
      const record=save(evaluateTextAction(context,text,{id:`${id}:${context.asin}`,needEvidenceRefs:sourceRefs,kind:"proposal"}));
      ids.push(record.candidateId);
      records.push(record);
    }
    return {text:renderRuleActions(records),ruleDecisionIds:ids};
  }

  function audience(text:string,id="keyword-audience"):RuleActionResult {
    const ids:string[]=[];
    const records:DecisionRecord[]=[];
    for(const context of contexts) {
      const audienceRefs=(rawByAsin.get(context.asin)??[]).filter(e=>e.kind === "keyword" && /toddler|baby|infant|kids?|child|year|儿童|幼儿|年龄/i.test(e.text)).map(e=>e.id);
      const record=save(evaluateTextAction(context,text,{id:`${id}:${context.asin}`,needEvidenceRefs:audienceRefs,kind:"proposal",proposalPurpose:"verify_audience"}));
      ids.push(record.candidateId);
      records.push(record);
    }
    return {text:renderRuleActions(records),ruleDecisionIds:ids};
  }

  function form():RuleActionResult {
    const ids:string[]=[];
    const groups=groupCompatibleProducts(contexts);
    const parts=groups.map(group=>group.asins.map(asin=> {
      const context=contexts.find(c=>c.asin===asin)!;
      const titleEvidence=context.evidence.filter(e=>e.kind==="title" && e.text.trim()).map(e=>e.id);
      const record=save(decideProductCandidate(context,{id:`voc-form:${asin}`,asin,kind:"fact",text:context.title ? `商品原名：${context.title}` : "商品原名未提供",evidenceRefs:titleEvidence}));
      ids.push(record.candidateId);
      const structural = group.status === "conflict" ? "结构存在冲突" : group.status === "unknown" ? "结构待核对" : "结构已分组";
      return `${contexts.length>1 ? `【${asin}】` : ""}${context.category || context.title || "商品形态待核对"}（${structural}）`;
    }).join("、"));
    return {text:parts.join("；"),ruleDecisionIds:ids};
  }

  function applicability(dimension:"audiences"|"scenarios"):ApplicabilityProjection {
    const rows=markApplicabilityConflicts([...rawByAsin].sort(([a],[b])=>a.localeCompare(b)).flatMap(([asin,evidence])=>
      evidence.filter(source=>source.kind==="voc" && source.scope==="asin" && source.location===dimension)
        .flatMap(source=> { const parsed=parseApplicabilityObservation({id:source.id,asin,text:source.text}); return parsed ? [parsed] : []; })));
    const ids:string[]=[];
    for(const row of rows) {
      const context=contexts.find(item=>item.asin===row.asin)!;
      const decision=decideProductCandidate(context,{id:`voc-applicability:${dimension}:${row.id}`,asin:row.asin,kind:"fact",text:row.text,evidenceRefs:[row.id],sourceObservation:dimension});
      if(decision.outcome==="supported") {
        decision.reasonCode=`voc_${row.status}`;
        decision.summary=row.status==="restricted" ? "原文记录了不适用或不推荐限制；保留限制，不纳入正向定位。" : row.status==="conditional" ? "原文带有适用条件；仅保留在该 ASIN 下，摘要同时保留完整条件。" : row.status==="reported" ? "引用当前 ASIN 的 VOC 原文记录，不据此推导硬件或通用适用性。" : row.status==="conflict" ? "同一 ASIN 的适用与限制记录冲突；保留双方原文，核对前不纳入正向定位。" : "原文未明确适用范围；保留缺失说明，不纳入正向定位。";
        if(row.status==="conflict" || row.status==="unknown") decision.outcome="needs_check";
        decision.checks.push(decision.summary);
      }
      save(decision); ids.push(decision.candidateId);
    }
    return {...renderApplicability(rows,scope.asins,dimension),ruleDecisionIds:ids};
  }

  return {scope,contexts,decisions,action,explain,audience,form,applicability,needs,trace:():AnalysisRuleTrace|undefined=>contexts.length ? buildAnalysisRuleTrace(contexts,decisions) : undefined};
}

/** Extend live output explanations with the same scoped contexts, never reinterpret saved reports. */
export function explainFinalActions(base:AnalysisRuleTrace|undefined, keyword:AnalysisRuleTrace|undefined, rows:Array<{dimension:string;action:string;ruleDecisionIds?:string[]}>) {
  if (!base?.contexts?.length) return base ?? keyword;
  const keywordMatches = keyword?.ruleSetVersion === base.ruleSetVersion && JSON.stringify(keyword.inputScope) === JSON.stringify(base.inputScope);
  const contexts=base.contexts.map(context=> {
    const other=keywordMatches ? keyword?.contexts?.find(c=>c.asin===context.asin) : undefined;
    return {...context,evidence:[...new Map([...context.evidence,...(other?.evidence??[])].map(e=>[e.id,e])).values()],needs:[...new Map([...context.needs,...(other?.needs??[])].map(e=>[e.id,e])).values()]};
  });
  const decisions=[...base.decisions,...(keywordMatches ? keyword?.decisions ?? [] : [])];
  for(const row of rows) {
    if(row.ruleDecisionIds?.length && row.ruleDecisionIds.every(id=>decisions.some(d=>d.candidateId===id && d.text===row.action))) continue;
    const origins=decisions.filter(d=>row.ruleDecisionIds?.includes(d.candidateId) && d.kind === "proposal");
    // Feature layers summarize existing judgments; they are not fresh actions
    // that may broaden the source scope or turn a blocked proposal into a fact.
    if(row.dimension.startsWith("功能分层-") && origins.length) {
      row.ruleDecisionIds=origins.map(d=>d.candidateId);
      const items=origins.map(d=>`${contexts.length>1 ? `【${d.asin}】` : ""}${d.outcome === "supported" ? row.action : `待核对：${d.summary}`}`);
      row.action=[...new Set(items)].join("；");
      continue;
    }
    // Keep conclusion/source records when adding a distinct action explanation.
    row.ruleDecisionIds=(row.ruleDecisionIds??[]).filter(id=>decisions.some(d=>d.candidateId===id && d.kind==="fact"));
    const rowDecisions:DecisionRecord[]=[];
    const dimension=/人群|年龄|尺寸/.test(row.dimension) ? "audiences" : /场景/.test(row.dimension) ? "scenarios" : /差异/.test(row.dimension) ? "unmet" : /基础|卖点/.test(row.dimension) ? "positives" : /痛点|避坑|结构/.test(row.dimension) ? "negatives" : null;
    for(const context of contexts) {
      const ownedOrigins=origins.filter(d=>d.asin===context.asin);
      if(origins.length && !ownedOrigins.length) continue;
      const scopedAction=actionForAsin(row.action,context.asin,contexts);
      if(scopedAction===null) continue;
      // Reuse the actual blocked decision behind an upstream explanation. The
      // wrapper describes a result; running it as a new proposal launders it.
      if (/^(?:核对「|待核对[：:])/u.test(scopedAction)) {
        const blocked=ownedOrigins.filter(d=>d.outcome !== "supported" && scopedAction.includes(d.summary));
        if(blocked.length) {
          rowDecisions.push(...blocked);
          row.ruleDecisionIds.push(...blocked.map(d=>d.candidateId));
          continue;
        }
      }
      const originRefs=new Set(ownedOrigins.flatMap(d=>d.evidenceRefs));
      const refs=context.needs.filter(e=>origins.length ? originRefs.has(e.id) : !dimension || e.location===dimension || (dimension==="audiences" && e.kind==="keyword")).map(e=>e.id);
      const record=evaluateTextAction(context,scopedAction,{id:`final-dimension:${row.dimension}:${context.asin}`,needEvidenceRefs:refs,proposalPurpose:dimension==="audiences" ? "verify_audience" : undefined});
      decisions.push(record);row.ruleDecisionIds.push(record.candidateId);
      rowDecisions.push(record);
    }
    row.action=renderRuleActions(rowDecisions,contexts.length);
  }
  return buildAnalysisRuleTrace(contexts,decisions);
}

function actionForAsin(text:string,asin:string,contexts:ProductContext[]):string|null {
  // Upstream actions already carry per-ASIN ownership. Never feed the whole
  // mixed-product paragraph back into every product's rule evaluation.
  const markers=contexts.flatMap(context=>{
    const token=`【${context.asin}】`;
    const found:Array<{index:number;end:number;asin:string}>=[];
    for(let index=text.indexOf(token);index>=0;index=text.indexOf(token,index+token.length)) found.push({index,end:index+token.length,asin:context.asin});
    return found;
  }).sort((a,b)=>a.index-b.index);
  if(!markers.length) return text;
  const owned=markers.flatMap((marker,index)=>marker.asin===asin ? [text.slice(marker.end,markers[index+1]?.index).replace(/[；;\s]+$/u,"")] : []);
  return owned.length ? owned.join("；") : null;
}

/** Only adopted candidates belong in the formal action column. Rejected text
 * remains available in its decision record; missing evidence gets a specific check. */
function renderRuleActions(records:DecisionRecord[],scopeCount=records.length):string {
  const texts=records.map(record=>record.outcome==="supported" ? record.text : `待核对：${record.summary}`);
  if(new Set(texts).size===1 && records.length===scopeCount) return texts[0] ?? "待核对输入来源";
  return records.map((record,index)=>`【${record.asin}】${texts[index]}`).join("；");
}

function groundedAction(label:string, dimension:Dimension, context:ProductContext) {
  if(dimension === "positives") return `保留「${label}」带来的体验；用实际使用演示与前后对照验证改版后体验没有下降`;
  const intro = dimension === "unmet" ? `围绕「${label}」制作改进样件` : `复现「${label}」问题并比较改进样件`;
  if(/连接|松动|结构|耐用|断裂|强度|quality|durab|reliab/i.test(label)) return `${intro}；定位失效部位，验证连接强度、防松及反复使用后的完整性，记录改进前后结果`;
  if(/容量|收纳|取放|容积|storage|capacity/i.test(label)) return `${intro}；测量实际可用空间，使用目标物品验证装入、取放及堆叠操作，记录尺寸与操作差异`;
  if(/握|把手|手柄|操控|转向|handle|steer|grip/i.test(label)) return `${intro}；按实际握持位置比较握持舒适度、操作力度及连接牢固性，核对实际使用条件`;
  if(/稳定|平衡|倾倒|balance|stabil/i.test(label) && !/温控|温度|加热|照明|亮度|heat|temperature|lighting|brightness/i.test(label)) {
    if(context.attributes.wheels?.state === "supported") return `${intro}；评估轮距与重心对稳定性的影响，按实际轮数制作对照样件，验证转弯及静置稳定性`;
    return `${intro}；核对接触面与重心，比较实际使用场景下的支撑稳定性`;
  }
  if(/融蜡|加热|温控|温度|heat|warm|melt/i.test(label)) return `${intro}；记录使用过程中的温度变化和效果一致性，核对控温方式及适用容器条件`;
  if(/眩光|亮度|照明|色温|glare|brightness|illumination/i.test(label)) return `${intro}；在目标使用场景对比照明均匀性、眩光和调节效果，确认光源条件后设定验收项`;
  if(/安装|组装|assembly/i.test(label)) return `${intro}；记录装配步骤、工具、错误点与完成时间，验证说明和零件标识改版是否降低操作错误`;
  if(/包装|破损|缺件|package/i.test(label)) return `${intro}；检查易损位置与装箱清单，验证运输保护及缺件复核效果`;
  if(/尺寸|适龄|年龄|size|age/i.test(label)) return `${intro}；核对实际尺寸与商品适龄限制，验证操作难度，不能由搜索人群词直接认定适用年龄`;
  return `${intro}；按原反馈描述的使用步骤设置对照，记录问题出现条件、频次及改进后的实际效果`;
}

export function keywordRuleSources(analysis:KeywordDemandAnalysis, scope?:Partial<AnalysisInputScope>):ProductLaunchRuntimeSources {
  return {manualVocByAsin:{},keywordDemand:analysis,analysisScope:scope};
}
