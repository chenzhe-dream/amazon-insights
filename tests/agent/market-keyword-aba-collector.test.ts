import assert from 'node:assert/strict';
import test from 'node:test';
import {collectMarketKeywordAba} from '../../server/services/market-keyword-aba-collector';
import type {RemoteMcpConnector,ConnectorRequest} from '../../server/connectors/connector-contract';
import {ConnectorError} from '../../server/connectors/connector-contract';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';
const scope=keywordPageRun().run.scope,now=new Date('2026-09-13T00:00:00.000Z');
const payload={country:'US',granularity:'month',keywords:[{keyword:'floor lamp',data_points:1,dates:['2026-08'],volumes:[100],ranks:[1],top3_click_shares:[.2],top3_conversion_shares:[0]}]};
const connector=(execute:RemoteMcpConnector['execute']):RemoteMcpConnector=>({id:'sif',execute,probe:async()=>{throw new Error('Unused');}});
test('ABA collector binds exact keywords and organization, making one governed business request',async()=>{
 const calls:ConnectorRequest[]=[];
 const result=await collectMarketKeywordAba({scope,keywords:['floor lamp'],referenceMonth:'2026-08',jobId:'aba-collector',connector:connector(async request=>{calls.push(request);return {data:payload,source:{connectorId:'sif',operation:request.operation,fetchedAt:now.toISOString(),attemptCount:1}};})},now);
 assert.equal(result.status,'ready');assert.equal(calls.length,1);
 assert.deepEqual(calls[0].input,{country:'US',granularity:'month',keywords:['floor lamp']});
 assert.deepEqual(calls[0].governorScope,{organizationId:scope.organizationId,jobId:'aba-collector'});
});
test('ABA collector rejects wrong connector metadata and preserves explicit failures without retry',async()=>{
 for(const source of [{connectorId:'sorftime',operation:'market_get_keyword_history'},{connectorId:'sif',operation:'different'}] as const){
  const result=await collectMarketKeywordAba({scope,keywords:['floor lamp'],referenceMonth:'2026-08',jobId:'aba-collector',connector:connector(async()=>({data:payload,source:{...source,fetchedAt:now.toISOString(),attemptCount:1}}))},now);
  assert.equal(result.status,'failed');
 }
 let calls=0;const result=await collectMarketKeywordAba({scope,keywords:['floor lamp'],referenceMonth:'2026-08',jobId:'aba-collector',connector:connector(async()=>{calls++;throw new ConnectorError('sif','rate-limit',true);})},now);
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.failure.code,'rate-limit');assert.equal(calls,1);
});
test('ABA timeout settles even when a connector ignores abort; invalid input never dispatches',async()=>{
 let calls=0;const hangs=connector(async()=>{calls++;return new Promise(()=>{});});
 const result=await collectMarketKeywordAba({scope,keywords:['floor lamp'],referenceMonth:'2026-08',jobId:'aba-collector',timeoutMs:10,connector:hangs},now);
 assert.equal(result.status,'failed');if(result.status==='failed')assert.equal(result.failure.code,'timeout');assert.equal(calls,1);
 const invalid=await collectMarketKeywordAba({scope,keywords:Array(11).fill('floor lamp'),referenceMonth:'2026-08',jobId:'aba-collector',connector:hangs},now);
 assert.equal(invalid.status,'failed');assert.equal(calls,1);
});
