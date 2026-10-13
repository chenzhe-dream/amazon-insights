import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {collectMarketKeywordTrend} from '../../server/services/market-keyword-collector';
import {readMarketKeywordTrendEvidence} from '../../server/domain/market-research/keyword-trend-evidence';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import type {ConnectorResult,ConnectorRequest} from '../../server/connectors/connector-contract';
const recorded=JSON.parse(readFileSync(new URL('../fixtures/market-keyword-trend-floor-lamp-20261013.json',import.meta.url),'utf8')) as ConnectorResult;
const scope={organizationId:'array-replay',researchId:'11111111-1111-4111-8111-111111111111',marketplace:'US' as const,nodeIdPath:'1063294',fromMonth:'2026-09',toMonth:'2026-09',currency:'USD' as const};
const now=new Date('2026-10-13T06:00:00Z');
async function replay(response:ConnectorResult=structuredClone(recorded)){
 let request:ConnectorRequest|undefined;
 const result=await collectMarketKeywordTrend({scope,jobId:'offline-array',keyword:'floor lamp',connector:{id:'sorftime',async probe(){throw Error('no network');},async execute(input){request=input;return response;}}},now);
 return {result,request};
}
test('recorded monthly pairs restore volume and rank with explicit monthly request and unknown CPC',async()=>{
 const {result,request}=await replay();assert.equal(result.status,'partial');
 assert.equal(request?.input.type,2);
 const data=(recorded.data as any).data;
 assert.equal(result.months[0].searchVolume.value,Number(data.search_volume_trend[data.search_volume_trend.indexOf('202609')+1]));
 assert.equal(result.months[0].searchRank.value,Number(data.rank_trend[data.rank_trend.indexOf('202609')+1]));
 assert.equal(result.months[0].recommendedBid.value,null);assert.equal(result.cpcCurrency,null);
 assert.equal(result.evidence.units.recommendedBid.status,'unknown');
 assert.match(result.evidence.units.recommendedBid.reason,/ambiguous/);
 assert.ok(result.issues.some(i=>i.code==='unknown-unit'&&i.path[1]==='cpc_trend'));

 const {evidence:source,issues,...trend}=result;void issues;const sourceRef=`market-source:${digest(source)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:source.fetchedAt,expectedRecordIds:[result.memberId],records:[{id:result.memberId,scope,data:{collection:'keyword-trend',trend,sourceRef}}]},now);
 assert.deepEqual(await readMarketKeywordTrendEvidence({scope,keyword:result.keyword,source,sourceRef,snapshot}),result);
});
test('malformed monthly pair arrays fail rather than inventing values',async()=>{
 for(const values of [['202609'],['202613','12'],['202609','-1'],['202609','1.5'],['202609','1e3'],['202609','9007199254740992'],['20260901','12'],['202609','12','2026-08 search volume 12']]){
 const response=structuredClone(recorded);(response.data as any).data.search_volume_trend=values;
 assert.equal((await replay(response)).result.status,'failed',JSON.stringify(values));}
});
test('conflicting pairs preserve unknown month while duplicate identical months remain usable',async()=>{
 const response=structuredClone(recorded);(response.data as any).data.search_volume_trend=['202608','0','202608','0','202609','12','202609','15'];
 const {result}=await replay(response);assert.notEqual(result.status,'failed');if(result.status==='failed')return;
 assert.equal(result.months[0].searchVolume.value,null);assert.equal(result.series.searchVolume.find(p=>p.month==='2026-08')?.measurement.value,0);
 assert.ok(result.issues.some(i=>i.code==='conflicting-month'));assert.ok(result.issues.some(i=>i.code==='duplicate-month'));
});

test('monthly pairs exclude incomplete current months from observations',async()=>{
 const response=structuredClone(recorded);(response.data as any).data.search_volume_trend=['202609','12','202610','13'];
 const {result}=await replay(response);assert.notEqual(result.status,'failed');if(result.status==='failed')return;
 assert.equal(result.series.searchVolume.find(p=>p.month==='2026-10')?.measurement.reason,'incomplete-month');assert.ok(!result.observedCompleteMonths.includes('2026-10'));
});

// These are successful re-probes of two previously failed words. They prove
// current payload compatibility, not the cause of the missing original response.
for (const [keyword, volume] of [['tall floor lamps for living room', 8552], ['tall lamp for bedroom', 19535]] as const) {
 test(`successful re-probe ${keyword} remains compatible without relaxing validation`, async () => {
  const response = JSON.parse(readFileSync(new URL(`../fixtures/market-keyword-trend-${keyword.replaceAll(' ', '-')}-20261013.json`, import.meta.url), 'utf8')) as ConnectorResult;
  const result = await collectMarketKeywordTrend({ scope, jobId: 'offline-reprobe', keyword, connector: {
   id: 'sorftime', probe: async () => { throw Error('no network'); }, execute: async () => response,
  } }, new Date(response.source.fetchedAt));
  assert.equal(result.status, 'partial');
  assert.equal(result.months[0].searchVolume.value, volume);
  assert.equal(result.months[0].recommendedBid.value, null);
  assert.deepEqual(result.evidence.payload, response.data);
  const { evidence: source, issues, ...trend } = result; void issues;
  const sourceRef = `market-source:${digest(source)}`;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'keywords', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: source.fetchedAt, expectedRecordIds: [result.memberId], records: [{ id: result.memberId, scope, data: { collection: 'keyword-trend', trend, sourceRef } }] }, new Date(source.fetchedAt));
  assert.deepEqual(await readMarketKeywordTrendEvidence({ scope, keyword, source, sourceRef, snapshot }), result);
 });
}
