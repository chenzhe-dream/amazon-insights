import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeMarketKeywordAbaSource} from '../../server/domain/market-research/keyword-aba-source';
import {readMarketKeywordAbaEvidence} from '../../server/domain/market-research/keyword-aba-evidence';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {MARKET_SOURCE_HANDLER_VERSION} from '../../shared/market-source-contracts';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';

function fixture(){
 const scope=keywordPageRun().run.scope,now=new Date('2026-09-13T00:00:00.000Z');
 const result=normalizeMarketKeywordAbaSource({scope,keywords:['floor lamp'],referenceMonth:'2026-08',fetchedAt:now.toISOString(),rawPayload:{country:'US',granularity:'month',keywords:[{keyword:'floor lamp',data_points:1,dates:['2026-08'],volumes:[10],ranks:[0],top3_click_shares:[0],top3_conversion_shares:[null]}]}},now);
 if(result.status==='failed')throw new Error('Invalid fixture');
 const {evidence:source,...batch}=result,sourceRef=`market-source:${digest(source)}`,members=result.members.map(m=>({keywordId:m.memberId,keyword:m.keyword}));
 const batchId=`keyword-aba-batch:${digest(members.map(m=>m.keywordId))}`;
 const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:MARKET_SOURCE_HANDLER_VERSION,ruleVersion:'source-normalization/v1',collectedAt:now.toISOString(),expectedRecordIds:[batchId],records:[{id:batchId,scope,data:JSON.parse(JSON.stringify({collection:'keyword-aba',result:batch,sourceRef}))}]},now);
 return {scope,snapshot,sourceRef,source,members,referenceMonth:'2026-08'};
}
test('saved ABA replay binds zero and missing fields to the exact keyword, month, raw source and snapshot',()=>{
 const input=fixture(),result=readMarketKeywordAbaEvidence(input);
 assert.equal(result.members[0].top3ClickShare.value,0);assert.equal(result.members[0].top3ConversionShare.reason,'missing-value');
 assert.equal(result.sourceScope.nodeBinding,'unverified');
 for(const changed of [{...input,referenceMonth:'2026-07'},{...input,members:[{...input.members[0],keyword:'floor lamps'}]},
  {...input,sourceRef:`market-source:${'0'.repeat(64)}`},{...input,scope:{...input.scope,nodeIdPath:'99:88'}}])assert.throws(()=>readMarketKeywordAbaEvidence(changed));
});
test('rehashing cached ABA values or source metadata cannot bypass raw-source replay',()=>{
 const input=fixture(),{snapshot}=input;
 const record=JSON.parse(JSON.stringify(snapshot.records[0]));record.data.result.members[0].top3ClickShare.value=.9;
 const changed=createMarketInputSnapshot({scope:input.scope,kind:'keywords',sourceVersion:snapshot.sourceVersion,ruleVersion:snapshot.ruleVersion,collectedAt:snapshot.collectedAt,expectedRecordIds:snapshot.expectedRecordIds,records:[record]},new Date(snapshot.collectedAt));
 assert.throws(()=>readMarketKeywordAbaEvidence({...input,snapshot:changed}),/ABA evidence/);
 const source={...input.source,coverage:{...input.source.coverage,expectedCount:10}};
 assert.throws(()=>readMarketKeywordAbaEvidence({...input,source,sourceRef:`market-source:${digest(source)}`}),/ABA evidence/);
});
