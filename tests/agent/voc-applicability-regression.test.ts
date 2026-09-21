import assert from "node:assert/strict";
import test from "node:test";
import { buildProductLaunchAnalysis, type LaunchProductInput } from "../../app/product-launch-analysis";
import { buildFinalProductDefinition } from "../../app/final-product-definition";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";
import { parseApplicabilityObservation, markApplicabilityConflicts } from "../../shared/voc-applicability";
import { buildKeywordLaunchConclusions } from "../../app/keyword-demand-conclusions";
import { buildKeywordDemandAnalysis } from "../../app/keyword-demand-analysis";

function record(asin: string, audiences: string[], scenarios: string[]): ManualAlexaVocNormalizedRecord {
  return {asin, attention:["【结构耐用】约 60% 提及"], positives:["【耐用性】约 40% 提及"], negatives:["【连接松动】约 30% 提及"], unmet:[], audiences, scenarios, motives:[], captureStatus:"dialog", alexaReport:{title:"Fixture",asin,captureStatus:"dialog",rating:4,reviewCount:100,prompt:"fixture",overallConclusion:"连接需要改进"}};
}
const snow: LaunchProductInput={asin:"B0SNOW0001",brand:"Snow",title:"Snow sleds with handle",subRankCategory:"Snow Sleds",price:40};
function run(products: LaunchProductInput[], manual: Record<string,ManualAlexaVocNormalizedRecord>) {
  const analysis=buildProductLaunchAnalysis(products,{manualVocByAsin:manual,keywordDemand:null,analysisScope:{organizationId:"org",projectId:"project",marketplace:"US"}});
  const final=buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:products.length,dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,hasVocData:true});
  return {analysis,final};
}

test("real-row regression: negative audience/scenario labels never become positive one-line positioning",()=>{
  const {analysis,final}=run([snow],{[snow.asin]:record(snow.asin,["人群分类｜特征","主要用户｜5-12岁儿童（最佳年龄段）","不推荐｜3岁以下幼儿（需要平衡能力）"],["场景｜说明与示例","最优场景｜后院小坡、社区小雪坡","冰面｜冰面上控制困难，不适合使用。"])});
  assert.doesNotMatch(final.oneLiner,/为【不推荐|在【冰面/);
  assert.match(final.oneLiner,/5-12岁儿童/);
  assert.match(final.oneLiner,/后院小坡/);
  const scene=analysis.vocPositioning.dimensionRows.find(row=>row.dimension==="核心场景")!;
  assert.match(scene.conclusion,/冰面.*不适合/);
  assert.match(final.definitionRows.find(row=>row.dimension==="核心场景")!.vocBasis,/冰面.*不适合/);
  assert.equal(final.oneLiner,analysis.vocPositioning.oneLiner);
  assert.equal(final.oneLinerCards.find(card=>card.key==="scenario")!.value,scene.conclusion);
  const decisions=final.ruleTrace!.decisions.filter(d=>scene.ruleDecisionIds?.includes(d.candidateId));
  assert.ok(decisions.some(d=>d.kind==="fact" && /冰面/.test(d.text) && d.evidenceRefs.some(ref=>ref.includes(":scenarios:"))),"row explains actual conclusion evidence as well as proposed action");
});

test("mixed ASINs keep conditional ice use local and preserve other products' exclusions",()=>{
  const other={...snow,asin:"B0SNOW0002",brand:"Other"};
  const manual={
    [snow.asin]:record(snow.asin,["5-12岁儿童｜需成人监督"],["雪地小坡｜适合滑行","冰面｜不适合，控制困难"]),
    [other.asin]:record(other.asin,["8-12岁儿童｜适合初学者"],["可接受场景｜冬季冰上区域（有防滑设计）"]),
  };
  const first=run([snow,other],manual), reverse=run([other,snow],manual);
  const scene=first.analysis.vocPositioning.dimensionRows.find(row=>row.dimension==="核心场景")!.conclusion;
  assert.match(scene,/B0SNOW0001/); assert.match(scene,/B0SNOW0002/);
  assert.match(scene,/有防滑设计/); assert.match(scene,/不适合/);
  assert.equal(scene,reverse.analysis.vocPositioning.dimensionRows.find(row=>row.dimension==="核心场景")!.conclusion);
  assert.equal(first.final.oneLiner,reverse.final.oneLiner);
});

test("only exclusions or unknown applicability never fabricates a positive audience or scene",()=>{
  const {final}=run([snow],{[snow.asin]:record(snow.asin,["不推荐｜3岁以下幼儿"],["不适合｜冰面","其他用途｜暂无数据"])});
  assert.match(final.oneLiner,/人群.*待核对|待核对.*人群/);
  assert.match(final.oneLiner,/场景.*待核对|待核对.*场景/);
  assert.doesNotMatch(final.oneLiner,/为【不推荐|在【冰面/);
});

test("lighting and unknown storage categories preserve negative and conditional context",()=>{
  for(const [title,scenarios] of [
    ["Reading desk lamp",["室内书桌｜适合阅读","浴室｜不适合潮湿环境使用"]],
    ["Woven storage basket",["室内收纳｜仅限干燥物品","食品储存｜不推荐直接接触食物"]],
  ] as const) {
    const product={...snow,title,subRankCategory:"Other"};
    const {analysis,final}=run([product],{[product.asin]:record(product.asin,["成人｜主要用户"],[...scenarios])});
    assert.match(final.oneLiner,new RegExp(scenarios[0].split("｜")[0]));
    const conclusion=analysis.vocPositioning.dimensionRows.find(row=>row.dimension==="核心场景")!.conclusion;
    assert.ok(conclusion.includes(scenarios[1]));
    if(title.includes("basket")) assert.match(final.oneLiner,/仅限干燥物品/);
  }
});

test("same-ASIN opposing scene sources are retained as conflict without choosing a positive winner",()=>{
  const {analysis,final}=run([snow],{[snow.asin]:record(snow.asin,["主要用户｜成年人"],["冰面｜适合使用","不适合，冰面｜无法控制"])});
  assert.match(final.oneLiner,/场景待核对/);
  const row=analysis.vocPositioning.dimensionRows.find(row=>row.dimension==="核心场景")!;
  assert.match(row.conclusion,/冲突/);
  const decisions=analysis.ruleTrace!.decisions.filter(d=>d.candidateId.startsWith("voc-applicability:scenarios:"));
  assert.equal(decisions.length,2);
  assert.ok(decisions.every(d=>d.outcome==="needs_check" && d.reasonCode==="voc_conflict"));
});

test("semantic parsing preserves postfix exclusions and conditions without treating no experience as exclusion",()=>{
  const parse=(text:string)=>parseApplicabilityObservation({id:text,asin:snow.asin,text});
  assert.equal(parse("人群分类｜特征"),null);
  assert.equal(parse("浴室｜不适合潮湿环境使用")!.status,"restricted");
  assert.equal(parse("Adult｜No experience required")!.status,"reported");
  assert.equal(parse("Ice｜Only with non-slip design")!.status,"conditional");
  assert.equal(parse("Ice｜Not recommended for this product")!.status,"restricted");
  assert.equal(parse("Ice｜Not specified")!.status,"unknown");
  const rows=[parse("Ice｜Suitable")!,{...parse("Ice｜Not suitable")!,asin:"B0OTHER001"}];
  assert.ok(markApplicabilityConflicts(rows).every(row=>row.status!=="conflict"),"other ASIN restrictions cannot become local conflicts");
});

test("review: bracketed VOC conflicts, common negative forms and mixed clauses preserve polarity",()=>{
  const parse=(text:string)=>parseApplicabilityObservation({id:text,asin:snow.asin,text})!;
  const conflict=markApplicabilityConflicts([parse("【冰面】适合使用"),parse("【冰面】不适合使用")]);
  assert.ok(conflict.every(row=>row.status==="conflict"));
  assert.equal(parse("低幼｜不建议使用").status,"restricted");
  assert.equal(parse("冰面｜不能使用").status,"restricted");
  const {final}=run([snow],{[snow.asin]:record(snow.asin,["主要用户｜成年人"],["雪地｜适合雪地，不适合冰面"])});
  assert.match(final.oneLiner,/适合雪地，不适合冰面/);
  assert.doesNotMatch(final.oneLiner,/场景待核对/);
  const complementary=markApplicabilityConflicts([parse("冰面｜仅在有防滑设计时使用"),parse("冰面｜不适合无防滑设计产品")]);
  assert.ok(complementary.every(row=>row.status!=="conflict"));
});

test("keyword audience/scenario remains demand evidence and cannot replace scoped VOC conclusions",()=>{
  const {analysis}=run([snow],{[snow.asin]:record(snow.asin,["主要用户｜8-12岁儿童","不推荐｜低幼"],["雪地小坡｜适合使用","冰面｜不适合使用"])});
  const baseline=buildKeywordLaunchConclusions(buildKeywordDemandAnalysis([snow],{analysisByAsin:{},enrichmentByKeyword:{}}),[snow]);
  const keyword={...baseline,hasData:true,sections:[{id:"customer_profile",title:"人群",items:[{label:"核心使用人群",value:"toddler"},{label:"主要使用场景",value:"ice racing"}]}]};
  const final=buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:1,dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword,hasVocData:true});
  const scene=final.definitionRows.find(row=>row.dimension==="核心场景")!;
  assert.match(scene.conclusion,/雪地小坡/);
  assert.doesNotMatch(scene.conclusion,/ice racing/);
  assert.match(scene.keywordBasis,/搜索场景线索.*ice racing/);
  const audience=final.definitionRows.find(row=>row.dimension==="目标人群\/年龄")!;
  assert.match(audience.conclusion,/8-12岁儿童/);
  assert.match(audience.conclusion,/不推荐｜低幼/);
  assert.match(audience.conclusion,/搜索人群线索：toddler/);
  assert.ok(audience.ruleDecisionIds!.some(id=>id.startsWith("voc-applicability:audiences:")));
});

test("review: failed or foreign fallback data cannot become scoped applicability facts",()=>{
  const other={...snow,asin:"B0OTHER001"};
  const blocks=[{key:"consumerProfile" as const,rows:[{label:"低幼｜适合使用",sharePct:100}]},{key:"scenarios" as const,rows:[{label:"冰面｜适合使用",sharePct:100}]}];
  for(const fallback of [{status:"failed",blocks},{status:"pending",blocks},{status:"ready",asin:snow.asin,blocks}]) {
    const analysis=buildProductLaunchAnalysis([snow,other],{manualVocByAsin:{[snow.asin]:record(snow.asin,["成人｜适合使用"],["雪地｜适合使用"])},keywordDemand:null,reviewAnalysisByAsin:{[other.asin]:fallback}});
    assert.ok(!analysis.ruleTrace!.decisions.some(d=>d.asin===other.asin && d.candidateId.startsWith("voc-applicability:") && d.outcome==="supported"));
    assert.doesNotMatch(analysis.vocPositioning.oneLiner,/低幼｜适合使用|冰面｜适合使用/);
  }
  const ready=buildProductLaunchAnalysis([other],{manualVocByAsin:{},keywordDemand:null,reviewAnalysisByAsin:{[other.asin]:{status:"ready",blocks}}});
  assert.ok(ready.ruleTrace!.decisions.some(d=>d.asin===other.asin && d.candidateId.startsWith("voc-applicability:") && d.outcome==="supported"));
});
