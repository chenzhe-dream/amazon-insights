import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalVocDefinition, selectLocalVocSources } from "../../app/local-voc-definition";
import { VocAutomationService } from "../../server/services/voc-automation-service";

const products = ["B08Z36X6B4", "B0BVFX154J", "B01N6NL766"].map(asin => ({asin, brand: asin, title: "Shelf floor lamp", productFamily: "lighting" as const}));
const manual = Object.fromEntries(products.map(p => [p.asin, {asin:p.asin,captureStatus:"dialog", attention:["【照明】100%"],positives:["【亮度】100%"],negatives:["【稳定性】100%"],unmet:[],audiences:[],scenarios:[],motives:[]}])) as never;

test("local report waits for manual input, then renders synchronously without model requests", () => {
 const empty = renderToStaticMarkup(createElement(LocalVocDefinition,{products,sources:{manualVocByAsin:{},keywordDemand:null},enabled:true}));
 assert.match(empty,/等待手工 VOC/);
 const html = renderToStaticMarkup(createElement(LocalVocDefinition,{products,sources:{manualVocByAsin:manual,keywordDemand:null},enabled:true}));
 assert.match(html,/本地规则分析/);
 assert.match(html,/新品定义/);
 assert.doesNotMatch(html,/正在分析手工 VOC|等待手工 VOC/);
});

test("scope rebuild uses every selected ASIN and excludes unrelated manual and keyword sources", () => {
 const input = {manualVocByAsin:{...manual as Record<string,never>,B000000000:{} as never},keywordDemand:null,keywordSources:{analysisByAsin:{},enrichmentByKeyword:{}}};
 const result = selectLocalVocSources(products.slice(1),input,false);
 assert.deepEqual(Object.keys(result.manualVocByAsin).sort(),products.slice(1).map(p=>p.asin).sort());
 assert.deepEqual(result.keywordDemand?.competitorBreakdown.map(p=>p.asin).sort(),products.slice(1).map(p=>p.asin).sort());
});

test("disabled automation cannot create background model jobs after import or timer tick", async () => {
 const service = new VocAutomationService({repository:new Proxy({}, {get(){throw new Error("unexpected database access");}}) as never,disabled:true});
 await service.afterImport({organizationId:"org",projectId:"project",actorId:"actor"},"run");
 await service.tick();
 service.start();
 await service.stop();
 await assert.rejects(service.register({organizationId:"org",projectId:"project",actorId:"actor"},{} as never),/本地规则/);
});


test("three ASINs retain all 150 keyword rows; selecting two rebuilds only their 100 rows", () => {
 const analysisByAsin = Object.fromEntries([...products,{asin:"B000000000"}].map(p => [p.asin,{asin:p.asin,marketplace:"US",status:"ready",fetchedAt:"2026-09-11",totalKeywordsInPeriod:50,topKeywordsAnalyzed:50,keywords:Array.from({length:50},(_,index)=>({keyword:`shelf lamp ${p.asin} ${index}`,trafficShare:2,searchVolume:100}))}])) as never;
 const sources = {manualVocByAsin:manual,keywordDemand:null,keywordSources:{analysisByAsin,enrichmentByKeyword:{}}};
 const all = selectLocalVocSources(products,sources,false).keywordDemand!;
 assert.equal(all.meta.totalKeywords,150);
 assert.equal(all.meta.readyCount,3);
 assert.equal(all.meta.uniqueKeywords,150);
 assert.ok(all.competitorBreakdown.every(p=>p.keywords.length===50));
 const subset = selectLocalVocSources(products.slice(1),sources,false).keywordDemand!;
 assert.equal(subset.meta.totalKeywords,100);
 assert.equal(subset.meta.readyCount,2);
});

test("review fallback is opt-in and never mixes reviews into an ASIN with manual VOC", () => {
 const review = {status:"ready",blocks:[{title:"正面评价",rows:[{label:"评论主题",detail:"稳定"}]}]} as never;
 const sources = {manualVocByAsin:{[products[0].asin]:manual[products[0].asin]},keywordDemand:null,reviewFallbackCandidates:Object.fromEntries(products.map(p=>[p.asin,review]))};
 assert.deepEqual(selectLocalVocSources(products,sources,false).reviewAnalysisByAsin,{});
 assert.deepEqual(Object.keys(selectLocalVocSources(products,sources,true).reviewAnalysisByAsin!).sort(),products.slice(1).map(p=>p.asin).sort());
});
