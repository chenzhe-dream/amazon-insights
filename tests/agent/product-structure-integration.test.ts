import assert from "node:assert/strict";
import test from "node:test";
import { buildKeywordDemandAnalysis, type KeywordDemandSources } from "../../app/keyword-demand-analysis";
import { buildKeywordLaunchConclusions } from "../../app/keyword-demand-conclusions";
import { buildProductLaunchAnalysis, type LaunchProductInput } from "../../app/product-launch-analysis";
import { buildFinalProductDefinition } from "../../app/final-product-definition";
import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";

const snow: LaunchProductInput = { asin: "B0SNOW0001", brand: "Fixture Snow", title: "Snow Scooter with handle and gliding board, no wheels", subRankCategory: "Snow Sleds", productFamily: "scooter", price: 40 };
function voc(asin: string): ManualAlexaVocNormalizedRecord {
  return { asin, attention: ["【结构耐用】约 60% 提及"], positives: ["【握持舒适】约 40% 提及"], negatives: ["【连接件松动】约 30% 提及"], unmet: ["【把手连接更牢固】约 20% 提及"], audiences: ["【不推荐低幼使用，适用年龄需核对】"], scenarios: ["【雪地滑行】约 70% 提及"], motives: ["【户外活动】约 60% 提及"], captureStatus: "dialog", alexaReport: { title: "Fixture VOC", asin, captureStatus: "dialog", rating: 4.5, reviewCount: 100, prompt: "fixture", overallConclusion: "连接件需要改进" } };
}
function demand(products: LaunchProductInput[]) {
  const metrics = {abaRank:null,cpcMedian:null,cpcLow:null,cpcHigh:null,naturalRatio:null,trafficDependency:null,organicRank:null,rankEvolution:null,keywordHealth:null,top3ClickShare:null,top3ConversionShare:null,clickConversionRate:null};
  const sources: KeywordDemandSources = { analysisByAsin: Object.fromEntries(products.map(p => [p.asin, { asin:p.asin, marketplace:"US", fetchedAt:"2026-09-16", status:"ready", totalKeywordsInPeriod:2, topKeywordsAnalyzed:2, keywords:[{...metrics,keyword:"toddler snow sled",trafficShare:70,searchVolume:10000},{...metrics,keyword:"snow scooter",trafficShare:30,searchVolume:5000}] }])), enrichmentByKeyword:{} };
  return buildKeywordDemandAnalysis(products, sources);
}
test("A01: snow aliases and toddler demand do not inject wheel structures into keyword or final actions", () => {
  const kd = demand([snow]);
  const kw = buildKeywordLaunchConclusions(kd,[snow]);
  const params = kw.sections.find(s=>s.id === "customer_profile")!.items.find(i=>i.label === "人群→产品参数")!.value;
  assert.doesNotMatch(params,/三轮|轮距|可调高度手把/);
  assert.match(params,/适龄|尺寸|年龄/);
  const analysis = buildProductLaunchAnalysis([snow], { manualVocByAsin:{[snow.asin]:voc(snow.asin)},keywordDemand:kd });
  const report = buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:1,dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,priceBand:analysis.productDefinition.targetPrice,hasVocData:true});
  assert.doesNotMatch(analysis.negativePriorityRows.map(r=>r.fixDirection).join(" "),/PU|前叉|前轮|后轮|轮距/);
  assert.doesNotMatch(report.definitionRows.map(r=>r.action).join(" "),/三轮|轮距/);
  assert.match(analysis.negativePriorityRows.map(r=>r.fixDirection).join(" "),/连接|松动/);
  assert.match(analysis.vocPositioning.oneLiner,/Snow Sleds|雪地/);
});

test("A03: a two-wheel product is not asserted to have three wheels", () => {
  const product = {...snow,asin:"B0WHEEL001", title:"Two wheel kick scooter with handlebar",subRankCategory:"Kick Scooters"};
  const result=buildProductLaunchAnalysis([product],{manualVocByAsin:{[product.asin]:voc(product.asin)},keywordDemand:null});
  assert.doesNotMatch(result.vocPositioning.dimensionRows.find(r=>r.dimension==="产品形态")!.conclusion,/三轮/);
});

function analysisFor(product:LaunchProductInput, negative:string) {
  const record={...voc(product.asin),positives:[],unmet:[],audiences:[],scenarios:[],negatives:[`【${negative}】约 60% 提及`]};
  return buildProductLaunchAnalysis([product],{manualVocByAsin:{[product.asin]:record},keywordDemand:null,analysisScope:{organizationId:"org-test",projectId:"project-test",marketplace:"US"}});
}

test("A02: verified three wheels retain applicable stability improvements and explanations",()=>{
  const product={...snow,title:"Three wheel scooter",features:["three wheels"],subRankCategory:"Kick Scooters"};
  const result=analysisFor(product,"稳定性不足");
  assert.match(result.negativePriorityRows[0].fixDirection,/轮距|重心/);
  const ids=result.negativePriorityRows[0].ruleDecisionIds!;
  assert.ok(ids.length>0);
  assert.ok(ids.every(id=>result.ruleTrace!.decisions.find(d=>d.candidateId===id)?.outcome==="supported"));
});

test("A04/A05: shared lamp name does not swap heating and reading actions",()=>{
  const wax=analysisFor({...snow,title:"Candle warmer lamp for melting wax",subRankCategory:"Candle Lamps",productFamily:"lighting"},"加热温控不稳定");
  assert.match(wax.negativePriorityRows[0].fixDirection,/温度变化|控温/);
  assert.doesNotMatch(wax.negativePriorityRows[0].fixDirection,/阅读|色温|眩光/);
  const reading=analysisFor({...snow,title:"Reading desk lamp for illumination",subRankCategory:"Desk Lamps",productFamily:"lighting"},"照明眩光严重");
  assert.match(reading.negativePriorityRows[0].fixDirection,/照明均匀|眩光/);
  assert.doesNotMatch(reading.negativePriorityRows[0].fixDirection,/蜡|加热/);
});

test("A06: unknown nonelectric category keeps specific capacity actions through positioning",()=>{
  const result=analysisFor({...snow,title:"Woven storage basket",subRankCategory:"Storage Baskets",productFamily:"generic"},"容量不足取放困难");
  assert.match(result.negativePriorityRows[0].fixDirection,/测量实际可用空间|取放/);
  assert.ok(result.vocPositioning.optimizeRows.some(row=>/容量|取放/.test(row.direction) && /测量实际可用空间/.test(row.productAction)));
  assert.doesNotMatch(result.vocPositioning.optimizeRows.map(row=>row.productAction).join(" "),/电器|电压|灯泡|车轮/);
  assert.equal(result.ruleTrace!.contexts![0].attributes.wheels.state,"unknown");
});

test("A07/A08/A16: mixed product order preserves own action sources and audience negation",()=>{
  const wheeled={...snow,asin:"B0WHEEL002",title:"Three wheel scooter",subRankCategory:"Kick Scooters",features:["three wheels"]};
  const manual=Object.fromEntries([snow,wheeled].map(p=>[p.asin,{...voc(p.asin),negatives:["【稳定性不足】约 60% 提及"]}]));
  const run=(products:LaunchProductInput[])=>buildProductLaunchAnalysis(products,{manualVocByAsin:manual,keywordDemand:null,analysisScope:{organizationId:"org-test",projectId:"mixed-project",marketplace:"US"}});
  const first=run([snow,wheeled]), second=run([wheeled,snow]);
  const projections=(result:ReturnType<typeof run>)=>result.ruleTrace!.decisions.filter(d=>d.candidateId.startsWith("voc-negative:")).map(d=>({asin:d.asin,text:d.text,outcome:d.outcome,refs:d.evidenceRefs})).sort((a,b)=>a.asin.localeCompare(b.asin));
  assert.equal(projections(first).length,2);
  assert.deepEqual(projections(first),projections(second));
  const snowDecisions=first.ruleTrace!.decisions.filter(d=>d.asin===snow.asin && d.outcome==="supported");
  assert.doesNotMatch(snowDecisions.filter(d=>d.kind==="proposal").map(d=>d.text).join(" "),/轮距|三轮/);
  assert.ok(snowDecisions.every(d=>d.evidenceRefs.every(ref=>!ref.startsWith(wheeled.asin))));
  assert.match(first.vocPositioning.dimensionRows.find(row=>row.dimension==="目标人群")!.conclusion,/不推荐低幼/);
  assert.equal(first.vocPositioning.ruleTrace!.ruleSetVersion,first.ruleTrace!.ruleSetVersion);
  const final=buildFinalProductDefinition({categoryLabel:first.meta.categoryLabel,productCount:2,dataMonth:first.meta.dataMonth,vocPositioning:first.vocPositioning,keyword:first.keywordConclusions,hasVocData:true});
  const finalSnow=final.ruleTrace!.decisions.filter(d=>d.asin===snow.asin && d.candidateId.startsWith("final-dimension:开发优先级"));
  assert.ok(finalSnow.some(d=>d.outcome==="supported" && /接触面与重心/.test(d.text)),"final step keeps the snow product's own grounded action");
  assert.doesNotMatch(finalSnow.filter(d=>d.outcome==="supported").map(d=>d.text).join(" "),/轮距|三轮/);
});
