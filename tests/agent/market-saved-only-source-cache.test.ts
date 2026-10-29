import test from 'node:test';
import assert from 'node:assert/strict';
import {createSorftimeSourceCache} from '../../scripts/lib/sorftime-source-cache.mjs';
import {callSorftimeTool} from '../../scripts/lib/sorftime-mcp-client.mjs';
import {withSharedProviderSource} from '../../scripts/lib/shared-provider-source-client.mjs';
import {createSellerSpriteConnector} from '../../server/connectors/mcp-connectors';
test('missing cache configuration cannot bypass saved-only and probes are also fenced',async()=>{
 let dispatches=0;
 const fetchImpl=async()=>{dispatches++;throw Error('Unexpected network');};
 await assert.rejects(callSorftimeTool('fixture-key','product_detail',{asin:'B000000001',amz_site:'US'},{env:{},savedOnly:true,fetchImpl}),/仅使用已保存/);
 for(const provider of ['sellerSprite','sif'])await assert.rejects(withSharedProviderSource(provider,'fixture-key','fixture',{}, {env:{},savedOnly:true},async()=>{dispatches++;return {};}),/仅使用已保存/);
 const connector=createSellerSpriteConnector({env:{MARKET_EXTERNAL_COLLECTION_MODE:'saved-only'},fetchImpl,resolveCredential:async()=> 'fixture-key',policy:{timeoutMs:500,maxAttempts:1,retryDelayMs:0,maxConcurrent:1,maxQueue:0}});
 try{await connector.probe();assert.equal(dispatches,0);}finally{await connector.close?.();}
});
test('saved-only cache miss never dispatches, even with force refresh',async()=>{
 for(const forceRefresh of [false,true]){
  let dispatches=0;
  const client={query:async(sql:string)=>({rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:[],rowCount:0}),release(){}};
  const cache=createSorftimeSourceCache({pool:{connect:async()=>client} as any});
  await assert.rejects(cache.run({provider:'sorftime',key:'fixture-key',endpoint:'https://fixture.invalid/mcp',tool:'product_detail',args:{asin:'B000000001',amz_site:'US'},savedOnly:true,forceRefresh} as any,async()=>{dispatches++;return {data:{}};}),/仅使用已保存/);
  assert.equal(dispatches,0);
 }
});
test('saved-only cache hit preserves original timestamp and does not dispatch',async()=>{
 let dispatches=0;
 const client={query:async(sql:string)=>({rows:sql.startsWith('SELECT payload')?[{payload:{data:{asin:'B000000001'}},fetched_at:new Date('2026-10-01T00:00:00Z')}]:[],rowCount:0}),release(){}};
 const cache=createSorftimeSourceCache({pool:{connect:async()=>client} as any});
 const result=await cache.run({provider:'sorftime',key:'fixture-key',endpoint:'https://fixture.invalid/mcp',tool:'product_detail',args:{asin:'B000000001',amz_site:'US'},savedOnly:true} as any,async()=>{dispatches++;return {};});
 assert.equal(dispatches,0);assert.equal(result.data.asin,'B000000001');
});
