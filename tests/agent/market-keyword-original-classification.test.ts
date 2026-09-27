import test from 'node:test';
import assert from 'node:assert/strict';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {buildMarketKeywordRuleReport} from '../../server/domain/market-research/keyword-rule-report';

async function builder(){
 const module=await import('../../server/domain/market-research/keyword-original-classification').catch(()=>null);
 assert.equal(typeof module?.buildKeywordOriginalClassification,'function','original automatic classification must be available');
 return module!.buildKeywordOriginalClassification;
}
function fixture(words=['floor lamp','floor lamps for living room','dimmable floor lamp for kids','razor scooter']){
 const facts=keywordRuleFixture().response.run.facts!,base=facts.members[0];
 facts.members=words.map((keyword,i)=>({...structuredClone(base),keywordId:`test-${i}`,keyword}));
 const {factsId,...basis}=facts;void factsId;facts.factsId=`market-keyword-facts:${digest(basis)}`;return facts;
}
test('original rules classify dimensions and group by product, scene and audience without a model',async()=>{
 const build=await builder(),facts=fixture(),before=digest(facts),result=build(facts,'floor lamp');
 assert.equal(result.factsId,facts.factsId);assert.equal(result.version,'keyword-original-classification/v1');
 const labels=(i:number,d:'W1'|'W2'|'W3'|'W4')=>result.classification.assignments[i][d].map(id=>result.classification.labels[d].find(l=>l.labelId===id)!.label);
 assert.deepEqual(labels(0,'W1'),['floor lamp']);assert.deepEqual(labels(1,'W3'),['客厅']);
 assert.deepEqual(labels(2,'W2'),['儿童']);assert.deepEqual(labels(2,'W4'),['调光']);
 assert.deepEqual(labels(3,'W2'),[]);assert.equal(result.classification.assignments[3].clusterId,null);
 assert.equal(result.meanings[3].category,'brand_competitor');assert.equal(result.classification.clusters.length,3);
 assert.deepEqual(result,build(facts,'floor lamp'));assert.equal(digest(facts),before);
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:result}});
 assert.equal(report.classification.kind,'local');assert.equal(report.clusters.length,3);
 assert.equal(report.aggregation.unassigned.memberCount,1);assert.ok(report.clusters.every(c=>c.score.pvs===null));
 const foreign=structuredClone(result);foreign.factsId='market-keyword-facts:'+'a'.repeat(64);
 assert.throws(()=>buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:foreign}}),/classification/i);
 const tampered=structuredClone(result);tampered.classification.assignments[0].clusterId=null;
 assert.throws(()=>buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:tampered}}),/classification/i);
});
test('other category follows its product seed; absent audience stays empty and missing volume stays unknown',async()=>{
 const build=await builder(),facts=fixture(['electric scooter for adults','foldable electric scooter','electric scooter']);
 facts.members[2].reference.searchVolume=null;facts.members[2].trend.months=[];
 const {factsId,...basis}=facts;void factsId;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const result=build(facts,'electric scooter');
 assert.equal(result.classification.labels.W1[0].label,'electric scooter');
 assert.ok(result.classification.labels.W2.some(l=>l.label==='成人'));
 assert.deepEqual(result.classification.assignments[2].W2,[]);
 const report=buildMarketKeywordRuleReport({facts,classification:{kind:'local',report:result}});
 assert.equal(report.aggregation.pool.totalSearchVolume,null);
 assert.ok(report.clusters.every(c=>c.score.searchVolumeSharePercent===null));
});
test('valid 500-character seeds remain readable without exceeding editable label limits',async()=>{
 const build=await builder(),seed='floor lamp '.repeat(45).padEnd(500,'x'),result=build(fixture([seed]),seed);
 assert.equal(result.productSeed,seed);assert.ok(result.classification.labels.W1[0].label.length<=240);
 assert.ok(result.classification.clusters[0].label.length<=240);
});
