import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {collectMarketKeywordTrend} from '../../server/services/market-keyword-collector';
import {readMarketKeywordTrendEvidence} from '../../server/domain/market-research/keyword-trend-evidence';
import {projectKeywordHistoryMonths} from '../../server/domain/market-research/keyword-history-months';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import type {ConnectorResult} from '../../server/connectors/connector-contract';

const scope={organizationId:'history-test',researchId:'11111111-1111-4111-8111-111111111111',marketplace:'US' as const,nodeIdPath:'1069828',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
async function saved(response:ConnectorResult){
 const source=await collectMarketKeywordTrend({scope,keyword:String((response.data as {data:{keyword:string}}).data.keyword),jobId:'history-replay',connector:{id:'sorftime',probe:async()=>{throw Error('No network');},execute:async()=>structuredClone(response)}},new Date('2026-09-17T02:00:00.000Z'));
 if(source.status==='failed')throw Error('Invalid fixture');
 const {evidence,issues:_issues,...trend}=source,sourceRef=`market-source:${digest(evidence)}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:evidence.fetchedAt,expectedRecordIds:[source.memberId],records:[{id:source.memberId,scope,data:{collection:'keyword-trend',trend,sourceRef}}]},new Date(evidence.fetchedAt));
 return {scope,source:evidence,sourceRef,snapshot,keyword:source.keyword};
}
test('verified recorded source projects history outside single-month scope without altering saved identity',async()=>{
 const response=JSON.parse(readFileSync(new URL('../fixtures/market-keyword-trend-gel-pend-20260917.json',import.meta.url),'utf8')).result;
 const input=await saved(response),before=JSON.stringify(input);
 const checked=await readMarketKeywordTrendEvidence(input),history=projectKeywordHistoryMonths(checked,'2026-08');
 assert.equal(checked.months.length,1);
 assert.ok(history.length>12);
 assert.equal(history.find(m=>m.month==='2025-08')?.searchVolume.value,114);
 assert.equal(history.find(m=>m.month==='2026-08')?.searchVolume.value,260);
 assert.deepEqual(history.find(m=>m.month==='2026-08'),checked.months[0]);
 assert.ok(history.every(m=>m.month<='2026-08'));
 assert.equal(JSON.stringify(input),before);
});
test('projection preserves zeros and missing independent metrics and excludes future months',async()=>{
 const input=await saved({source:{connectorId:'sorftime',operation:'keyword_trend',fetchedAt:'2026-09-12T00:00:00.000Z',attemptCount:1},data:{data:{keyword:'floor lamps',search_volume_trend:['2026-06 search volume 0','2026-08 search volume 30','2026-09 search volume 90'],search_rank_trend:['2026-07 search rank 2'],recommended_bid_trend:[]}}});
 const checked=await readMarketKeywordTrendEvidence(input),history=projectKeywordHistoryMonths(checked,'2026-08');
 assert.deepEqual(history.map(m=>m.month),['2026-06','2026-07','2026-08']);
 assert.equal(history[0].searchVolume.value,0);assert.equal(history[1].searchVolume.value,null);
 assert.equal(history[1].searchRank.value,2);assert.equal(history[2].recentGrowth.reason,'missing-baseline');
 assert.equal(history[2].recommendedBid.value,null);
 const changed=structuredClone(input);Object.assign(changed.snapshot,{coverage:{...changed.snapshot.coverage,availableCount:0}});
 await assert.rejects(readMarketKeywordTrendEvidence(changed));
});
