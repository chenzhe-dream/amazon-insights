import assert from "node:assert/strict";
import { test } from "node:test";
import type { CurrentProjectDisplayVersion } from "../../app/lib/project-display-version-browser";
import type { ExportModuleContext } from "../../app/project-export/export-module-context";
import { exportVersionFixture } from "./helpers/project-export-fixture";

function context(): ExportModuleContext {
  const version = exportVersionFixture() as unknown as CurrentProjectDisplayVersion;
  return {projectId:version.projectId,organizationId:version.organizationId,marketplace:"US",asins:version.asins,
    sourceAsins:version.asins,currentRunId:version.runId,version,capturedAt:"2026-09-24T08:00:00Z"};
}
function stage(c:ExportModuleContext,name:string,data:unknown) {
  Object.assign(c.version!.stageOutputs,{[name]:{stage:name,stageStatus:"done",data}});
}
test("images retain all gallery slots and URL-matched full notes without importing unrelated products",async()=>{
  const {buildListingImagesExportSection}=await import("../../app/project-export/listing-images-export-section");
  const c=context(), asin=c.asins[0];
  const gallery=Array.from({length:12},(_,i)=>`https://m.media-amazon.com/i${i}.jpg`);
  stage(c,"listing",{contentByAsin:{[asin]:{asin,marketplace:"US",status:"ready",galleryImages:gallery,fetchedAt:"2026-09-21"}}});
  stage(c,"image_remarks",{remarksByAsin:{[asin]:gallery.map((imageUrl,i)=>({imageUrl,remark:`完整备注${i}`,image_types:["类型1","类型2","类型3"],confidence:"high"})),
    B000000000:[{remark:"其他项目私密备注"}]},outcomesByAsin:{}});
  const section=buildListingImagesExportSection(c);
  const json=JSON.stringify(section);
  assert.match(json,/完整备注11/);assert.match(json,/类型3/);assert.doesNotMatch(json,/其他项目私密备注/);
  stage(c,"image_remarks",{remarksByAsin:{[asin]:[{imageUrl:"https://m.media-amazon.com/old.jpg",remark:"错配备注",image_types:[],confidence:"high"}]},outcomesByAsin:{}});
  assert.doesNotMatch(JSON.stringify(buildListingImagesExportSection(c)),/错配备注/);
  stage(c,"listing",{contentByAsin:{[asin]:{asin,marketplace:"UK",galleryImages:gallery}}});
  assert.throws(()=>buildListingImagesExportSection(c),/范围|来源/);
});
test("keywords export every existing row, exact project enrichment, source dates and both analysis and insight",async()=>{
  const {buildKeywordsExportSection}=await import("../../app/project-export/keywords-export-section");
  const c=context(),asin=c.asins[0];
  const keywords=Array.from({length:230},(_,i)=>({keyword:i?"灯具关键词"+i:"toddler scooter",trafficShare:1,searchVolume:100+i,abaRank:null,
    cpcMedian:null,cpcLow:null,cpcHigh:null,naturalRatio:null,trafficDependency:null,organicRank:null,rankEvolution:null,keywordHealth:null,
    top3ClickShare:null,top3ConversionShare:null,clickConversionRate:null}));
  stage(c,"keywords",{analysisByAsin:{[asin]:{asin,marketplace:"US",fetchedAt:"2026-09-23",status:"ready",totalKeywordsInPeriod:1000,topKeywordsAnalyzed:230,keywords}},
    enrichmentByKeyword:{"toddler scooter":{keyword:"toddler scooter",fetchedAt:"2026-09-24",status:"ready",
      searchTrend:[{month:"2026-07",volume:1234,abaRank:12}],bidLow:1,bidMedian:2,bidHigh:3,clickConversionRate:4,top3ClickShare:5,top3ConversionShare:6},
      secret:{keyword:"secret",searchTrend:[{month:"private",volume:999,abaRank:8}]}}});
  const section=buildKeywordsExportSection(c),json=JSON.stringify(section);
  const matrix=section.blocks.find(b=>b.kind==="table"&&b.title==="完整流量词对比");
  assert.ok(matrix?.kind==="table");assert.equal(matrix.rows.length,230);
  assert.match(json,/灯具关键词229/);assert.match(json,/2026-09-23/);assert.match(json,/1234/);
  assert.match(json,/关键词洞察/);assert.doesNotMatch(json,/private|62787/);
  const groups=section.blocks.find(b=>b.kind==="table"&&b.title==="分类分组汇总");
  assert.ok(groups?.kind==="table");assert.equal(groups.rows.length,2);
  const taxonomy=section.blocks.find(b=>b.kind==="table"&&b.title==="关键词分类标准");
  assert.ok(taxonomy?.kind==="table");assert.ok(taxonomy.columns.includes("示例"));
  assert.ok(taxonomy.rows.every(row=>row.at(-1)?.text && row.at(-1)?.text!=="—"));
});

test("saved rule definitions and decision versions survive alongside current rule explanations",async()=>{
  const {buildExportRuleTrace}=await import("../../app/project-export/export-rule-trace");
  const {RULE_DEFINITIONS,RULE_SET_VERSION}=await import("../../shared/product-structure-rules");
  const scope={organizationId:"org",projectId:"project",marketplace:"US",asins:["B000000001"],inputRevision:"old-input"};
  const blocks=buildExportRuleTrace({
    ruleSetVersion:"historical-rule-set",
    ruleDefinitions:[{...structuredClone(RULE_DEFINITIONS[0]),version:"historical-definition",purpose:"原结果规则定义"}],
    inputScope:scope,sources:[],
    decisions:[{candidateId:"c1",asin:scope.asins[0],text:"历史结论",kind:"fact",outcome:"needs_check",reasonCode:"missing",
      summary:"待核对",checks:[],ruleSetVersion:"historical-decision",ruleIds:[],ruleVersions:{},
      inputScope:scope,evidenceRefs:[],matchedConditions:[]}],
  });
  const json=JSON.stringify(blocks);
  for(const text of ["historical-rule-set","historical-definition","historical-decision","原结果规则定义",RULE_SET_VERSION])assert.ok(json.includes(text));
});
test("missing image and keyword stages are missing rather than global generated examples",async()=>{
  const {buildListingImagesExportSection}=await import("../../app/project-export/listing-images-export-section");
  const {buildKeywordsExportSection}=await import("../../app/project-export/keywords-export-section");
  const c={...context(),version:null};
  assert.equal(buildListingImagesExportSection(c).status,"missing");
  assert.equal(buildKeywordsExportSection(c).status,"missing");
  const empty=context();stage(empty,"keywords",{analysisByAsin:{},enrichmentByKeyword:{}});
  const result=buildKeywordsExportSection(empty);
  assert.equal(result.status,"missing");assert.doesNotMatch(JSON.stringify(result),/C级：继续观察/);
});
