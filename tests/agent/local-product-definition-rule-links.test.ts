import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalProductDefinitionSection } from "../../app/local-product-definition-section";
import { buildProductLaunchAnalysis } from "../../app/product-launch-analysis";
import { buildFinalProductDefinition } from "../../app/final-product-definition";
import { buildAnalysisRuleTrace, buildProductContext, decideProductCandidate } from "../../shared/product-structure-rules";

test("original template retains saved decision explanations in the overview without adding row controls", () => {
  const analysis=buildProductLaunchAnalysis([],{manualVocByAsin:{},keywordDemand:null});
  const report=buildFinalProductDefinition({categoryLabel:'历史样例',productCount:1,dataMonth:'2026-09',vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,hasVocData:true});
  const asin='B0DDX8MYKQ';
  const scope={organizationId:'org',projectId:'project',marketplace:'US',asins:[asin],inputRevision:'saved'};
  const texts=['功能分层的独立来源','词群承接的独立来源','产品优先级的独立来源'];
  const context=buildProductContext({scope,asin,title:'Candle lamp',evidence:texts.map((text,i)=>({id:`s${i}`,asin,scope:'asin',kind:'voc',text,inputScope:scope}))});
  const decisions=texts.map((text,i)=>decideProductCandidate(context,{id:`d${i}`,asin,kind:'fact',text,sourceObservation:'audiences',evidenceRefs:[`s${i}`]}));
  report.ruleTrace=buildAnalysisRuleTrace([context],decisions);
  report.featureLayers.mustHave=[{item:'功能样例',evidence:'对应来源',ruleDecisionIds:['d0']}];
  report.keywordGroups=[{type:'词群样例',keywords:'lamp',productLink:'对应产品',listingAngle:'验证',skuHint:'验证',ruleDecisionIds:['d1']}];
  report.priorityRows=[{priority:'P1',direction:'方向样例',evidence:'对应来源',businessImpact:'体验',action:'验证',acceptance:'核对条件',ruleDecisionIds:['d2']}];
  const before=JSON.stringify(report);
  const html=renderToStaticMarkup(createElement(LocalProductDefinitionSection,{products:[],sources:{manualVocByAsin:{},keywordDemand:null},savedReport:report}));
  assert.ok(html.includes('analysis-rule-overview'));
  for(const text of texts) assert.ok(html.includes(text));
  assert.ok(!html.includes('analysis-rule-rowDetails') || !html.includes('<details class="analysis-rule-rowDetails"'));
  assert.ok(!html.includes('<th>判定依据</th>'));
  assert.equal(JSON.stringify(report),before);
});
