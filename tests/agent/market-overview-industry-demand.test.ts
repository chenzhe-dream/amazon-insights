import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {collectOverviewIndustryDemand,pickCategoryKeywords,parseAbaPoints} from '../../server/services/market-overview-industry-demand';
import {ConnectorError,type RemoteMcpConnector} from '../../server/connectors/connector-contract';
const scope={organizationId:randomUUID(),researchId:randomUUID(),marketplace:'US' as const,nodeIdPath:'123:456',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD' as const};
const at='2026-09-12T00:00:00.000Z';
function connector(id:'sellerSprite'|'sorftime',handler:(operation:string,input:any)=>unknown):RemoteMcpConnector{return {id,probe:async()=>{throw Error();},execute:async r=>({data:handler(r.operation,r.input) as any,source:{connectorId:id,operation:r.operation,fetchedAt:at,attemptCount:1}})};}
test('selection preserves original category filters and monthly searches parsing cutoff',()=>{
 const rows=['floor lamps','electric floor lamps','acme lamps','floor lamps outdoor','floor lamps broad'].map((keyword,i)=>({keyword,searches:100-i,resultCount:i===4?100000:50}));
 assert.deepEqual(pickCategoryKeywords(rows,'Floor Lamps').map(r=>r.keyword),['floor lamps','floor lamps outdoor']);
 assert.deepEqual(parseAbaPoints([{label:'202608',searches:0},{label:'202609',searches:10},{label:'bad',searches:9},{label:'202607',searches:null}], '2026-08'),[{month:'2026-08',value:0}]);
});
test('own sources are retained for partial failure and ABA uses direct monthly arguments',async()=>{
 const calls:any[]=[];const sorftime=connector('sorftime',()=>({data:[{keyword:'floor lamps',monthly_search_volume:'1,000',search_result_count:'90'},{keyword:'floor lamps outdoor',monthly_search_volume:'500',search_result_count:'90'}]}));
 const sellerSprite=connector('sellerSprite',(op,input)=>{calls.push({op,input});if(op==='keyword_research')return {data:{items:[]}};if(input.keyword==='floor lamps outdoor')throw new ConnectorError('sellerSprite','timeout',true);return {data:[{label:'202608',searches:12}]};});
 const result=await collectOverviewIndustryDemand({scope,seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime,sellerSprite},now:()=>new Date(at)});
 assert.equal(result.result.status,'partial');assert.equal(result.result.series[0].points[0].value,12);assert.equal(result.result.series[1].status,'failed');assert.equal(result.sources.length,4);assert.deepEqual(calls.find(c=>c.op==='aba_research_trend').input,{marketplace:'US',keyword:'floor lamps',timeGranularity:'M'});
});
test('empty series stays empty, and no missing number is coerced into zero',async()=>{
 const sorftime=connector('sorftime',()=>({data:[]})),sellerSprite=connector('sellerSprite',op=>op==='keyword_research'?{data:{items:[]}}:{data:[]});
 const {result}=await collectOverviewIndustryDemand({scope,seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime,sellerSprite},now:()=>new Date(at)});
 assert.equal(result.status,'empty');assert.equal(result.series.length,1);assert.deepEqual(result.series[0].points,[]);assert.equal(result.series[0].searches,null);
});
test('product node fallback uses own category and original wrapped request',async()=>{
 const calls:any[]=[];const sorftime=connector('sorftime',()=>({data:[]})),sellerSprite=connector('sellerSprite',(op,args)=>{calls.push({op,args});return op==='product_node'?{data:[{nodeIdPath:'123:456',nodeLabelPath:'Lighting:Floor Lamps'}]}:op==='keyword_research'?{data:{items:[]}}:{data:[{label:'202608',searches:'42'}]};});
 const {result}=await collectOverviewIndustryDemand({scope,seed:null,jobId:randomUUID(),connectors:{sorftime,sellerSprite},now:()=>new Date(at)});assert.equal(result.seed,'Floor Lamps');assert.equal(result.status,'ready');assert.deepEqual(calls[0],{op:'product_node',args:{request:{marketplace:'US',keyword:'456',month:'202608'}}});
});
test('cutoff retains last 48 available complete points without invented months',()=>{
 const points=Array.from({length:60},(_,i)=>({label:`${2021+Math.floor(i/12)}${String(i%12+1).padStart(2,'0')}`,searches:i}));
 const result=parseAbaPoints(points,'2025-06');assert.equal(result.length,48);assert.deepEqual(result.at(-1),{month:'2025-06',value:53});assert.equal(result[0].month,'2021-07');
});
test('cancelled demand dispatches no providers and complete-month guard rejects before calls',async()=>{
 let calls=0;const c=connector('sellerSprite',()=>{calls++;return {data:[]};}),controller=new AbortController();controller.abort();
 await assert.rejects(collectOverviewIndustryDemand({scope,seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime:{...c,id:'sorftime'},sellerSprite:c},signal:controller.signal,now:()=>new Date(at)}));assert.equal(calls,0);
 await assert.rejects(collectOverviewIndustryDemand({scope:{...scope,toMonth:'2026-09'},seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime:{...c,id:'sorftime'},sellerSprite:c},now:()=>new Date(at)}));assert.equal(calls,0);
});
test('duplicate trend months reject instead of plotting ambiguous values',()=>{assert.throws(()=>parseAbaPoints([{label:'202608',searches:1},{label:'2026-08',searches:2}],'2026-08'));});
test('wrong node fallback and contradictory response scope are explicit failures',async()=>{
 const sorftime=connector('sorftime',()=>({data:[]}));for(const payload of [{data:[{nodeIdPath:'999',nodeLabelPath:'Other'}]},{marketplace:'DE',data:[]}]){const sellerSprite=connector('sellerSprite',()=>payload);const {result}=await collectOverviewIndustryDemand({scope,seed:null,jobId:randomUUID(),connectors:{sorftime,sellerSprite},now:()=>new Date(at)});assert.equal(result.status,'failed');assert.equal(result.seed,null);assert.equal(result.issues[0].code,'scope-mismatch');}
});
test('per-call timeout cannot hang on a connector that ignores abort',async()=>{
 const sorftime:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error();},execute:async()=>new Promise(()=>{})},sellerSprite=connector('sellerSprite',()=>({data:[]}));
 const {result}=await collectOverviewIndustryDemand({scope,seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime,sellerSprite},timeoutMs:10,now:()=>new Date(at)});assert.equal(result.status,'failed');assert.equal(result.issues.filter(i=>i.code==='timeout').length,2);
});
test('governor denial retains successful series and native retry metadata',async()=>{
 const admission={reason:'rolling-window' as const,retryAt:'2026-09-12T00:01:00.000Z'},sorftime=connector('sorftime',()=>({data:[{keyword:'floor lamps',monthly_search_volume:'20'},{keyword:'floor lamps outdoor',monthly_search_volume:'10'}]})),sellerSprite=connector('sellerSprite',(op,args)=>{if(op==='keyword_research')return {data:[]};if(args.keyword==='floor lamps outdoor')throw new ConnectorError('sellerSprite','local-admission',true,admission);return {data:[{label:'202608',searches:10}]};});
 const collected=await collectOverviewIndustryDemand({scope,seed:'Floor Lamps',jobId:randomUUID(),connectors:{sorftime,sellerSprite},now:()=>new Date(at)});assert.equal(collected.result.status,'partial');assert.deepEqual(collected.admission,admission);assert.equal(collected.result.series[0].points[0].value,10);assert.equal(collected.result.series[1].errorCode,'local-admission');assert.equal(collected.result.issues.at(-1)?.retryable,true);
});
